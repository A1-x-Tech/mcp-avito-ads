import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { registerCatalogTools } from "./catalog.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface Config {
  title?: string;
  description?: string;
  annotations?: Annotations;
  inputSchema: z.ZodRawShape;
}

/** Fake server + fake client, so the handlers run without a network or an SDK. */
function harness(opts: { throwOn?: string } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const make = (method: string) => async (params: unknown) => {
    calls.push({ method, params });
    if (opts.throwOn === method) throw new Error("boom");
    return { data: { total: 1, items: [] }, apiPointBalance: 4832 };
  };
  const client = {
    listCampaigns: make("listCampaigns"),
    listGroups: make("listGroups"),
    listCreatives: make("listCreatives"),
    changeGroupBudget: make("changeGroupBudget"),
    changeGroupPrice: make("changeGroupPrice"),
  };
  const tools: Record<string, Handler> = {};
  const configs: Record<string, Config> = {};
  const server = {
    registerTool: (name: string, cfg: Config, handler: Handler) => {
      configs[name] = cfg;
      tools[name] = handler;
    },
  };
  registerCatalogTools(server as never, client as never);
  return { calls, tools, configs };
}

/** The input schema of one tool, as a parseable object. */
function schemaOf(name: string): z.ZodObject<z.ZodRawShape> {
  return z.object(harness().configs[name].inputSchema);
}

const text = (res: { content: { text: string }[] }): string => res.content[0].text;

test("registers the three list tools and the two group writes", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), [
    "change_group_budget",
    "change_group_price",
    "list_campaigns",
    "list_creatives",
    "list_groups",
  ]);
});

test("the list tools are read-only and the group writes are non-destructive and idempotent", () => {
  const { configs } = harness();
  for (const name of ["list_campaigns", "list_groups", "list_creatives"]) {
    assert.deepEqual(
      configs[name].annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      `${name} must be READ_ONLY`,
    );
  }
  // Setting a budget or a bid overwrites a field with the value given: a repeat
  // lands on the same state and destroys nothing. It must never be DESTRUCTIVE
  // (that hint is reserved for delete_user and the money transfers).
  for (const name of ["change_group_budget", "change_group_price"]) {
    assert.deepEqual(
      configs[name].annotations,
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      `${name} must be WRITE`,
    );
  }
});

test("every description spells out what this API cannot do", () => {
  const { configs } = harness();
  for (const [name, cfg] of Object.entries(configs)) {
    assert.match(cfg.description ?? "", /нельзя/, `${name} must state the missing surface`);
  }
});

test("list_campaigns renames the id filters onto their wire spelling and forwards paging", async () => {
  const { calls, tools } = harness();
  await tools.list_campaigns({
    ids: [1, 2],
    statuses: ["active"],
    contractIds: [10],
    additionalAgreementIds: [20],
    createdAt: { from: "2026-01-01", to: "2026-01-31" },
    limit: 50,
    page: 2,
  });
  assert.equal(calls[0].method, "listCampaigns");
  assert.deepEqual(calls[0].params, {
    filter: {
      ids: [1, 2],
      statuses: ["active"],
      contractIDs: [10],
      additionalAgreementIDs: [20],
      createdAt: { from: "2026-01-01", to: "2026-01-31" },
    },
    limit: 50,
    page: 2,
  });
});

test("an empty call sends an empty filter and lets the client default the paging", async () => {
  const { calls, tools } = harness();
  await tools.list_campaigns({});
  assert.deepEqual(calls[0].params, { filter: {}, limit: undefined, page: undefined });
});

test("list_groups and list_creatives map campaignIds/groupIds and keep the rest verbatim", async () => {
  const { calls, tools } = harness();
  await tools.list_groups({ campaignIds: [7], paces: ["even"], paymentModels: ["CPM"] });
  await tools.list_creatives({ groupIds: [3], campaignIds: [7], statuses: ["active"] });
  assert.equal(calls[0].method, "listGroups");
  assert.deepEqual(calls[0].params, {
    filter: { campaignIDs: [7], paces: ["even"], paymentModels: ["CPM"] },
    limit: undefined,
    page: undefined,
  });
  assert.equal(calls[1].method, "listCreatives");
  assert.deepEqual(calls[1].params, {
    filter: { groupIDs: [3], campaignIDs: [7], statuses: ["active"] },
    limit: undefined,
    page: undefined,
  });
});

test("the raw filter escape hatch merges, and a named field wins the conflict", async () => {
  const { calls, tools } = harness();
  await tools.list_campaigns({ ids: [1], filter: { ids: [9], someNewKey: true } });
  assert.deepEqual(calls[0].params, {
    filter: { ids: [1], someNewKey: true },
    limit: undefined,
    page: undefined,
  });
});

test("change_group_budget and change_group_price pass exactly the two fields through", async () => {
  const { calls, tools } = harness();
  await tools.change_group_budget({ groupId: 5, budget: 1000 });
  await tools.change_group_price({ groupId: 5, price: 250 });
  assert.deepEqual(calls[0], { method: "changeGroupBudget", params: { groupId: 5, budget: 1000 } });
  assert.deepEqual(calls[1], { method: "changeGroupPrice", params: { groupId: 5, price: 250 } });
});

test("the point balance rides along with the answer so the agent can pace itself", async () => {
  const { tools } = harness();
  assert.equal(text(await tools.list_groups({})), '{"data":{"total":1,"items":[]},"apiPointBalance":4832}');
});

test("a client error comes back as an isError result, not a throw", async () => {
  const { tools } = harness({ throwOn: "changeGroupBudget" });
  const res = await tools.change_group_budget({ groupId: 5, budget: 1000 });
  assert.equal(res.isError, true);
  assert.match(text(res), /boom/);
});

test("statuses are validated against each entity's own vocabulary", () => {
  assert.equal(schemaOf("list_campaigns").safeParse({ statuses: ["partial_moderation"] }).success, true);
  // A group status is not a campaign status, and vice versa.
  assert.equal(schemaOf("list_campaigns").safeParse({ statuses: ["will_launch_soon"] }).success, false);
  assert.equal(schemaOf("list_groups").safeParse({ statuses: ["will_launch_soon"] }).success, true);
  assert.equal(schemaOf("list_groups").safeParse({ statuses: ["erir_registration"] }).success, false);
  assert.equal(schemaOf("list_creatives").safeParse({ statuses: ["erir_registration"] }).success, true);
  assert.equal(schemaOf("list_creatives").safeParse({ statuses: ["deleted"] }).success, false);
});

test("paging, ids and date ranges are rejected before they reach the API", () => {
  const campaigns = schemaOf("list_campaigns");
  assert.equal(campaigns.safeParse({ limit: 100, page: 1 }).success, true);
  assert.equal(campaigns.safeParse({ limit: 101 }).success, false);
  assert.equal(campaigns.safeParse({ limit: 0 }).success, false);
  assert.equal(campaigns.safeParse({ page: 0 }).success, false);
  assert.equal(campaigns.safeParse({ ids: [0] }).success, false);
  assert.equal(campaigns.safeParse({ ids: [1.5] }).success, false);
  assert.equal(campaigns.safeParse({ createdAt: { from: "2026-01-01", to: "2026-01-31" } }).success, true);
  assert.equal(campaigns.safeParse({ createdAt: { from: "01.01.2026", to: "2026-01-31" } }).success, false);
  assert.equal(campaigns.safeParse({ createdAt: { from: "2026-01-01" } }).success, false);
  assert.equal(campaigns.safeParse({ campaignTypes: ["banner"] }).success, false);
  assert.equal(campaigns.safeParse({ paymentModels: ["cpm"] }).success, false);
  assert.equal(campaigns.safeParse({ paymentModels: ["CPM"] }).success, true);
});

test("the group writes require a positive id and an amount of at least 1", () => {
  const budget = schemaOf("change_group_budget");
  assert.equal(budget.safeParse({ groupId: 5, budget: 1 }).success, true);
  assert.equal(budget.safeParse({ groupId: 5, budget: 0 }).success, false);
  assert.equal(budget.safeParse({ groupId: 5, budget: 0.5 }).success, false);
  assert.equal(budget.safeParse({ groupId: 5, budget: -100 }).success, false);
  assert.equal(budget.safeParse({ groupId: 0, budget: 100 }).success, false);
  assert.equal(budget.safeParse({ budget: 100 }).success, false);
  assert.equal(budget.safeParse({ groupId: 5 }).success, false);

  const price = schemaOf("change_group_price");
  assert.equal(price.safeParse({ groupId: 5, price: 1 }).success, true);
  assert.equal(price.safeParse({ groupId: 5, price: 0 }).success, false);
  assert.equal(price.safeParse({ groupId: 5, price: "250" }).success, false);
});

test("each field of a tool gets its own schema instance (no $ref dedup in the JSON schema)", () => {
  const { configs } = harness();
  for (const [name, cfg] of Object.entries(configs)) {
    const fields = Object.values(cfg.inputSchema);
    assert.equal(new Set(fields).size, fields.length, `${name} reuses a schema object across fields`);
  }
});
