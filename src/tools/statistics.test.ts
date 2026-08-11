import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { AvitoAdsClient } from "../client.js";
import type { AvitoAdsConfig } from "../types.js";
import { registerStatisticsTools } from "./statistics.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolConfig {
  title?: string;
  description?: string;
  annotations?: Annotations;
  inputSchema: z.ZodRawShape;
}

/** Fake server + fake client, so the handlers run without a network or an McpServer. */
function harness(opts: { throwOn?: string; balance?: number | null } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const make = (method: string) => async (params: unknown) => {
    calls.push({ method, params });
    if (opts.throwOn === method) throw new Error("boom");
    return { data: { rows: [] }, apiPointBalance: opts.balance ?? 4832 };
  };
  const client = {
    campaignStats: make("campaignStats"),
    groupStats: make("groupStats"),
    creativeStats: make("creativeStats"),
  };
  const configs: Record<string, ToolConfig> = {};
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, cfg: ToolConfig, handler: Handler) => {
      configs[name] = cfg;
      tools[name] = handler;
    },
  };
  registerStatisticsTools(server as never, client as never);
  /** The tool's declared inputSchema as a parsable object, to test the rejections. */
  const schema = (name: string) => z.object(configs[name].inputSchema);
  return { calls, tools, configs, schema };
}

const PERIOD = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };

// --- Registration ---

test("registers exactly the three reporting tools", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), ["campaign_stats", "creative_stats", "group_stats"]);
});

test("every reporting tool is read-only, non-destructive, with all four hints", () => {
  const { configs } = harness();
  for (const [name, cfg] of Object.entries(configs)) {
    assert.deepEqual(
      cfg.annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      `${name} must be annotated READ_ONLY`,
    );
  }
});

test("every description names the metrics and the weekly point budget", () => {
  const { configs } = harness();
  for (const [name, cfg] of Object.entries(configs)) {
    const text = cfg.description ?? "";
    for (const metric of ["views", "clicks", "ctr", "spend", "cpm", "cpc", "vtr"]) {
      assert.match(text, new RegExp(`\\b${metric}\\b`), `${name} should document the ${metric} metric`);
    }
    assert.match(text, /API points/, `${name} should warn about the weekly point budget`);
    assert.match(text, /100 days/, `${name} should state the 100-day period cap`);
  }
});

// --- Forwarding ---

test("campaign_stats forwards the period to client.campaignStats", async () => {
  const { calls, tools } = harness();
  await tools.campaign_stats({ campaignId: 12, ...PERIOD });
  assert.equal(calls[0].method, "campaignStats");
  assert.deepEqual(calls[0].params, { campaignId: 12, ...PERIOD });
});

test("group_stats forwards groupIds unchanged", async () => {
  const { calls, tools } = harness();
  await tools.group_stats({ campaignId: 12, ...PERIOD, groupIds: [101, 102] });
  assert.equal(calls[0].method, "groupStats");
  assert.deepEqual(calls[0].params, { campaignId: 12, ...PERIOD, groupIds: [101, 102] });
});

test("creative_stats forwards creativeIds to client.creativeStats", async () => {
  const { calls, tools } = harness();
  await tools.creative_stats({ campaignId: 12, ...PERIOD, creativeIds: [9001] });
  assert.equal(calls[0].method, "creativeStats");
  assert.deepEqual(calls[0].params, { campaignId: 12, ...PERIOD, creativeIds: [9001] });
});

test("the result is compact JSON carrying the remaining point balance", async () => {
  const { tools } = harness({ balance: 17 });
  const res = await tools.campaign_stats({ campaignId: 12, ...PERIOD });
  assert.equal(res.content[0].text, '{"data":{"rows":[]},"apiPointBalance":17}');
});

test("a client error is returned as an isError result, not thrown", async () => {
  const { tools } = harness({ throwOn: "creativeStats" });
  const res = await tools.creative_stats({ campaignId: 12, ...PERIOD, creativeIds: [9001] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
});

// --- Input validation (the declared schema, as an MCP client would apply it) ---

test("dates must be YYYY-MM-DD, not timestamps or local formats", () => {
  const schema = harness().schema("campaign_stats");
  assert.equal(schema.safeParse({ campaignId: 1, ...PERIOD }).success, true);
  assert.equal(schema.safeParse({ campaignId: 1, dateFrom: "2026-01-01T00:00:00Z", dateTo: "2026-01-31" }).success, false);
  assert.equal(schema.safeParse({ campaignId: 1, dateFrom: "01.01.2026", dateTo: "2026-01-31" }).success, false);
  assert.equal(schema.safeParse({ campaignId: 1, dateFrom: "2026-01-01", dateTo: "last friday" }).success, false);
});

test("both dates are required on every reporting tool", () => {
  for (const name of ["campaign_stats", "group_stats", "creative_stats"]) {
    const schema = harness().schema(name);
    assert.equal(schema.safeParse({ campaignId: 1, dateFrom: "2026-01-01" }).success, false, name);
    assert.equal(schema.safeParse({ campaignId: 1, dateTo: "2026-01-31" }).success, false, name);
    assert.equal(schema.safeParse(PERIOD).success, false, `${name} must require campaignId`);
  }
});

test("campaignId must be a positive integer", () => {
  const schema = harness().schema("group_stats");
  const ids = { groupIds: [101] };
  assert.equal(schema.safeParse({ campaignId: 0, ...PERIOD, ...ids }).success, false);
  assert.equal(schema.safeParse({ campaignId: -3, ...PERIOD, ...ids }).success, false);
  assert.equal(schema.safeParse({ campaignId: 1.5, ...PERIOD, ...ids }).success, false);
  assert.equal(schema.safeParse({ campaignId: "12", ...PERIOD, ...ids }).success, false);
});

test("groupIds / creativeIds are required arrays of positive integer ids", () => {
  // The SDK makes the id list a required argument and documents no meaning for
  // omitting it, so the tool asks for it rather than inventing "all entities".
  const groups = harness().schema("group_stats");
  assert.equal(groups.safeParse({ campaignId: 1, ...PERIOD }).success, false, "groupIds is required");
  assert.equal(groups.safeParse({ campaignId: 1, ...PERIOD, groupIds: [101] }).success, true);
  assert.equal(groups.safeParse({ campaignId: 1, ...PERIOD, groupIds: [0] }).success, false);
  assert.equal(groups.safeParse({ campaignId: 1, ...PERIOD, groupIds: ["101"] }).success, false);
  const creatives = harness().schema("creative_stats");
  assert.equal(creatives.safeParse({ campaignId: 1, ...PERIOD }).success, false, "creativeIds is required");
  assert.equal(creatives.safeParse({ campaignId: 1, ...PERIOD, creativeIds: [9001] }).success, true);
  assert.equal(creatives.safeParse({ campaignId: 1, ...PERIOD, creativeIds: [-1] }).success, false);
});

test("no description claims an omitted id list means every entity of the campaign", () => {
  const { configs } = harness();
  for (const name of ["group_stats", "creative_stats"]) {
    const text = configs[name].description ?? "";
    assert.doesNotMatch(text, /omit it for every/i, `${name} must not promise unverified wire behaviour`);
    assert.match(text, /required/i, `${name} must say the id list is required`);
  }
});

test("each date field is its own schema instance (no $ref dedup in the JSON schema)", () => {
  const { configs } = harness();
  const shape = configs.campaign_stats.inputSchema;
  assert.notEqual(shape.dateFrom, shape.dateTo);
});

// --- Against the real client, over a mock fetch ---

const CONFIG: AvitoAdsConfig = {
  clientId: "CID",
  clientSecret: "SECRET",
  accountId: 777,
  environment: "production",
  apiBase: "https://api.avito.ru/ads/",
  retryBaseMs: 0,
  maxRetries: 0,
};

interface WireCall {
  url: string;
  method: string;
  body: unknown;
}

/** Registers the tools over a real client whose fetch is stubbed; records the wire traffic. */
function wireHarness(body: unknown = { groups: [] }) {
  const wire: WireCall[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    const raw = init.body === undefined ? undefined : String(init.body);
    wire.push({
      url: String(url),
      method: String(init.method),
      body: raw === undefined || !raw.startsWith("{") ? raw : JSON.parse(raw),
    });
    if (new URL(String(url)).pathname === "/token") {
      return new Response(JSON.stringify({ access_token: "TKN", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json", "Api-Point-Balance": "4700" },
    });
  }) as typeof fetch;

  const tools: Record<string, Handler> = {};
  const server = { registerTool: (name: string, _cfg: ToolConfig, handler: Handler) => (tools[name] = handler) };
  registerStatisticsTools(server as never, new AvitoAdsClient(CONFIG, fetchImpl));
  return { tools, wire, get apiCalls() {
    return wire.filter((c) => new URL(c.url).pathname !== "/token");
  } };
}

test("group_stats reaches the account-scoped POST with the API's groupIDs key", async () => {
  const h = wireHarness({ groups: [{ id: 101, totalData: { clicks: 5 } }] });
  const res = await h.tools.group_stats({ campaignId: 12, ...PERIOD, groupIds: [101] });

  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.apiCalls[0].method, "POST");
  assert.equal(h.apiCalls[0].url, "https://api.avito.ru/ads/v1/account/777/campaigns/12/groups/stats");
  assert.deepEqual(h.apiCalls[0].body, { ...PERIOD, groupIDs: [101] });
  assert.equal(res.content[0].text, '{"data":[{"id":101,"totalData":{"clicks":5}}],"apiPointBalance":4700}');
});

test("campaign_stats posts to the campaign stats path and returns the whole envelope", async () => {
  const h = wireHarness({ campaign: { id: 12 }, groups: [], creatives: [] });
  const res = await h.tools.campaign_stats({ campaignId: 12, ...PERIOD });

  assert.equal(h.apiCalls[0].url, "https://api.avito.ru/ads/v1/account/777/campaigns/12/stats");
  assert.deepEqual(h.apiCalls[0].body, PERIOD);
  assert.match(res.content[0].text, /"apiPointBalance":4700/);
});

test("an over-long period is refused before any request — no API point is spent", async () => {
  const h = wireHarness();
  const res = await h.tools.campaign_stats({ campaignId: 12, dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /100 days/);
  assert.equal(h.wire.length, 0);
});

test("dateFrom later than dateTo is refused before any request", async () => {
  const h = wireHarness();
  const res = await h.tools.creative_stats({ campaignId: 12, dateFrom: "2026-02-01", dateTo: "2026-01-01", creativeIds: [9001] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /dateFrom must not be later than dateTo/);
  assert.equal(h.wire.length, 0);
});

test("a date that is not a real calendar day is refused before any request", async () => {
  const h = wireHarness();
  const res = await h.tools.group_stats({ campaignId: 12, dateFrom: "2026-02-31", dateTo: "2026-03-01", groupIds: [101] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /real calendar dates/);
  assert.equal(h.wire.length, 0);
});
