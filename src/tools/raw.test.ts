import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { AvitoAdsClient } from "../client.js";
import type { AvitoAdsConfig } from "../types.js";
import { expandAccountPath, isReadMethod, registerRawTool } from "./raw.js";

const BASE = "https://api.avito.ru/ads/";
const ACCOUNT = 777;

interface ToolConfig {
  title?: string;
  description?: string;
  annotations?: Record<string, boolean>;
  inputSchema?: z.ZodRawShape;
}

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const isTokenUrl = (url: string) => new URL(url).pathname === "/token";

/**
 * Registers raw_request against a real client with a recording fetch stub, so
 * the SSRF guard and the account-scoped path resolution are exercised for real.
 * `calls` is the full transcript; `apiCalls` skips the token traffic.
 */
function harness(extra: Partial<AvitoAdsConfig> = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    const raw = init.body === undefined ? undefined : String(init.body);
    calls.push({ url: String(url), method: String(init.method), body: raw });
    if (isTokenUrl(String(url))) {
      return new Response(JSON.stringify({ access_token: "TKN", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Api-Point-Balance": "1234" },
    });
  }) as typeof fetch;

  const client = new AvitoAdsClient(
    {
      clientId: "CID",
      clientSecret: "SECRET",
      accountId: ACCOUNT,
      environment: "production",
      apiBase: BASE,
      retryBaseMs: 0,
      maxRetries: 0,
      ...extra,
    },
    fetchImpl,
  );

  let config: ToolConfig | undefined;
  let handler: Handler | undefined;
  const server = {
    registerTool: (_name: string, cfg: ToolConfig, h: Handler) => {
      config = cfg;
      handler = h;
    },
  };
  registerRawTool(server as never, client);

  return {
    raw: handler as Handler,
    config: config as ToolConfig,
    calls,
    get apiCalls() {
      return calls.filter((c) => !isTokenUrl(c.url));
    },
  };
}

// --- Helpers ---

test("isReadMethod is true only for GET (case-insensitive)", () => {
  assert.equal(isReadMethod("GET"), true);
  assert.equal(isReadMethod("get"), true);
  assert.equal(isReadMethod("POST"), false);
  assert.equal(isReadMethod("DELETE"), false);
});

test("expandAccountPath substitutes every spelling of the placeholder", () => {
  assert.equal(expandAccountPath("v1/account/{accountID}/users", 777), "v1/account/777/users");
  assert.equal(expandAccountPath("v1/account/{accountId}/balance", 777), "v1/account/777/balance");
  assert.equal(expandAccountPath("v1/account/{account_id}/balance", 777), "v1/account/777/balance");
  assert.equal(expandAccountPath("v1/account/{accountID}/group/{accountID}", 5), "v1/account/5/group/5");
  // Anything else is left alone: only the account is injected here. A literal
  // foreign account id survives this step and is refused by the client's
  // resolve() instead — see the cross-account test below.
  assert.equal(expandAccountPath("v1/account/9/campaigns/{campaignID}/stats", 777), "v1/account/9/campaigns/{campaignID}/stats");
});

// --- Registration ---

test("registers raw_request as a destructive write", () => {
  const h = harness();
  assert.ok(h.config.title);
  assert.deepEqual(h.config.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("the input schema takes path, method, body and confirmWrite, and requires only path", () => {
  const h = harness();
  const schema = z.object(h.config.inputSchema ?? {});
  assert.deepEqual(Object.keys(h.config.inputSchema ?? {}).sort(), ["body", "confirmWrite", "method", "path"]);
  assert.equal(schema.safeParse({ path: "v1/account/777/balance" }).success, true);
  assert.equal(schema.safeParse({}).success, false, "path is required");
  assert.equal(schema.safeParse({ path: "" }).success, false, "an empty path is rejected");
  assert.equal(schema.safeParse({ path: "x", method: "PUT" }).success, false, "PUT is not offered");
  assert.equal(schema.safeParse({ path: "x", method: "PATCH" }).success, false, "PATCH is not offered");
});

// --- The write gate ---

test("GET runs without confirmWrite and hits the account-scoped url", async () => {
  const h = harness();
  const res = await h.raw({ path: "v1/account/{accountID}/balance" });
  assert.equal(res.isError, undefined);
  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.apiCalls[0].method, "GET");
  assert.equal(h.apiCalls[0].url, "https://api.avito.ru/ads/v1/account/777/balance");
  assert.equal(h.apiCalls[0].body, undefined);
});

test("POST without confirmWrite is refused before any network call", async () => {
  const h = harness();
  const res = await h.raw({ path: "v1/account/{accountID}/funds-transfer", method: "POST", body: { amount: 100 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmWrite=true/);
  assert.equal(h.calls.length, 0, "not even a token may be minted");
});

test("GET with a body is refused with the fix named, not with fetch's opaque error", async () => {
  const h = harness();
  // GET is the default and `body` sits in the same schema, so asking for a
  // filtered read this way is the obvious mistake; fetch would answer
  // "Request with GET/HEAD method cannot have body", which names no way out.
  const res = await h.raw({ path: "v1/account/{accountID}/campaigns", body: { filter: {}, limit: 20 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /GET request cannot carry a body/);
  assert.match(res.content[0].text, /method="POST"/, "the message must name the fix");
  assert.equal(h.calls.length, 0, "not even a token may be minted");
});

test("an explicit GET with a body is refused too, not just the defaulted one", async () => {
  const h = harness();
  const res = await h.raw({ path: "v1/account/{accountID}/campaigns", method: "GET", body: { limit: 20 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /GET request cannot carry a body/);
  assert.equal(h.calls.length, 0);
});

test("DELETE without confirmWrite is refused before any network call", async () => {
  const h = harness();
  const res = await h.raw({ path: "v1/account/{accountID}/delete-user/42", method: "DELETE" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmWrite=true/);
  assert.equal(h.calls.length, 0);
});

test("POST with confirmWrite sends the JSON body", async () => {
  const h = harness();
  const res = await h.raw({
    path: "v1/account/{accountID}/campaigns",
    method: "POST",
    body: { filter: {}, limit: 20, page: 1 },
    confirmWrite: true,
  });
  assert.equal(res.isError, undefined);
  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.apiCalls[0].method, "POST");
  assert.equal(h.apiCalls[0].url, "https://api.avito.ru/ads/v1/account/777/campaigns");
  assert.deepEqual(JSON.parse(String(h.apiCalls[0].body)), { filter: {}, limit: 20, page: 1 });
});

test("DELETE with confirmWrite goes through", async () => {
  const h = harness();
  const res = await h.raw({
    path: "v1/account/{accountID}/delete-user/42",
    method: "DELETE",
    confirmWrite: true,
  });
  assert.equal(res.isError, undefined);
  assert.equal(h.apiCalls[0].method, "DELETE");
  assert.equal(h.apiCalls[0].url, "https://api.avito.ru/ads/v1/account/777/delete-user/42");
});

// --- Guards inherited from the client ---

test("a path escaping to another origin is an isError result, with no request sent", async () => {
  for (const evil of ["https://evil.example/steal", "http://evil.example/x", "\\\\evil.example/x"]) {
    const h = harness();
    const res = await h.raw({ path: evil });
    assert.equal(res.isError, true, `${JSON.stringify(evil)} should be isError`);
    assert.match(res.content[0].text, /foreign origin/);
    assert.equal(h.calls.length, 0, `must not fetch for ${JSON.stringify(evil)}`);
  }
});

test("a path climbing out of the API prefix is refused (the token endpoint stays out of reach)", async () => {
  const h = harness();
  const res = await h.raw({ path: "../token" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /must stay under/);
  assert.equal(h.calls.length, 0);
});

test("a path naming another account is refused — the account id is config, never an argument", async () => {
  // Without this, raw_request would be the one tool that can reach
  // funds-transfer and delete-user on an account the operator never configured.
  for (const path of [
    "v1/account/999/funds-transfer",
    "v1/account/777/../../account/999/funds-transfer",
    "v1/account/999/delete-user/1",
  ]) {
    const h = harness();
    const res = await h.raw({ path, method: "POST", confirmWrite: true });
    assert.equal(res.isError, true, `${path} should be isError`);
    assert.match(res.content[0].text, /must address the configured account 777/);
    assert.equal(h.calls.length, 0, `must not fetch for ${path}`);
  }
});

test("the description warns that the tool reaches the money and delete endpoints", () => {
  // The description is the only text the calling model reads: the warning that
  // lives in the source comments has to be in it too.
  const text = harness().config.description ?? "";
  assert.match(text, /funds-transfer/);
  assert.match(text, /delete-user/);
  assert.match(text, /confirmWrite=true is your explicit acknowledgement/);
});

test("an API error is returned as an isError result, not thrown", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    if (isTokenUrl(String(url))) {
      return new Response(JSON.stringify({ access_token: "TKN", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: "not_found", message: "no such path" }), { status: 404 });
  }) as typeof fetch;
  const client = new AvitoAdsClient(
    {
      clientId: "CID",
      clientSecret: "SECRET",
      accountId: ACCOUNT,
      environment: "production",
      apiBase: BASE,
      retryBaseMs: 0,
      maxRetries: 0,
    },
    fetchImpl,
  );
  let handler: Handler | undefined;
  registerRawTool({ registerTool: (_n: string, _c: unknown, h: Handler) => { handler = h; } } as never, client);

  const res = await (handler as Handler)({ path: "v1/account/{accountID}/nope" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /404/);
  assert.match(res.content[0].text, /no such path/);
});

// --- Result shape ---

test("the result is compact JSON with the weekly point balance attached", async () => {
  const h = harness();
  const res = await h.raw({ path: "v1/account/{accountID}/balance" });
  assert.equal(res.content[0].text.includes("\n"), false, "output must not be pretty-printed");
  assert.deepEqual(JSON.parse(res.content[0].text), { data: { ok: true }, apiPointBalance: 1234 });
});
