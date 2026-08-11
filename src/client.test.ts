import { test } from "node:test";
import assert from "node:assert/strict";

import { AvitoAdsClient, backoffMs, normalizeListRequest, validateContractInput } from "./client.js";
import { AvitoAdsError, ValidationError } from "./types.js";
import type { AvitoAdsConfig, ContractInput } from "./types.js";

const BASE = "https://api.avito.ru/ads/";
const TOKEN_URL = "https://api.avito.ru/token";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call, index: number) => Response;

/** The token endpoint follows the configured base, so match it by path. */
const isTokenUrl = (url: string) => new URL(url).pathname === "/token";

/** A token response the client will accept, valid for an hour. */
function tokenResponse(token = "TKN", expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Builds a client over a recording fetch stub. The handler sees every call
 * (token requests included) and returns the response for it; `calls` holds the
 * transcript, and `apiCalls` skips the token traffic.
 */
function harness(handler: Handler, extra: Partial<AvitoAdsConfig> = {}) {
  const calls: Call[] = [];
  const config: AvitoAdsConfig = {
    clientId: "CID",
    clientSecret: "SECRET",
    accountId: 777,
    environment: "production",
    apiBase: BASE,
    retryBaseMs: 0, // no real backoff delay in tests
    maxRetries: 2,
    ...extra,
  };
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const raw = init.body === undefined ? undefined : String(init.body);
    const call: Call = {
      url: String(url),
      method: String(init.method),
      headers,
      body: raw === undefined ? undefined : raw.startsWith("{") ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;

  return {
    client: new AvitoAdsClient(config, fetchImpl),
    calls,
    get apiCalls() {
      return calls.filter((c) => !isTokenUrl(c.url));
    },
  };
}

/** The common case: hand out a token, then answer every API call with `body`. */
function okHarness(body: unknown = { ok: true }, init: ResponseInit = {}, extra: Partial<AvitoAdsConfig> = {}) {
  return harness(
    (call) => (isTokenUrl(call.url) ? tokenResponse() : new Response(JSON.stringify(body), { status: 200, ...init })),
    extra,
  );
}

// --- Token flow ---

test("mints an OAuth2 token with client_credentials before the first call", async () => {
  const h = okHarness();
  await h.client.getBalance();

  assert.equal(h.calls[0].url, TOKEN_URL);
  assert.equal(h.calls[0].method, "POST");
  assert.equal(h.calls[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(String(h.calls[0].body));
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("client_id"), "CID");
  assert.equal(form.get("client_secret"), "SECRET");

  assert.equal(h.calls[1].url, `${BASE}v1/account/777/balance`);
  assert.equal(h.calls[1].method, "GET");
  assert.equal(h.calls[1].headers.Authorization, "Bearer TKN");
});

test("every request identifies the server with a User-Agent, token call included", async () => {
  const h = okHarness();
  await h.client.getBalance();
  // Without this header Node's fetch sends "node", which is indistinguishable
  // from any unidentified script in Avito's logs and rate-limit triage.
  assert.equal(h.calls[0].headers["User-Agent"], "mcp-avito-ads");
  assert.equal(h.calls[1].headers["User-Agent"], "mcp-avito-ads");

  const named = okHarness({}, {}, { userAgent: "mcp-avito-ads/1.2.3" });
  await named.client.getBalance();
  assert.equal(named.calls[0].headers["User-Agent"], "mcp-avito-ads/1.2.3");
  assert.equal(named.calls[1].headers["User-Agent"], "mcp-avito-ads/1.2.3");
});

test("caches the token across calls and mints exactly one", async () => {
  const h = okHarness();
  await h.client.getBalance();
  await h.client.listUsers();
  await h.client.getAccount();
  assert.equal(h.calls.filter((c) => c.url === TOKEN_URL).length, 1);
});

test("concurrent calls share a single in-flight token request", async () => {
  const h = okHarness();
  await Promise.all([h.client.getBalance(), h.client.listUsers(), h.client.getAccount()]);
  assert.equal(h.calls.filter((c) => c.url === TOKEN_URL).length, 1);
});

test("refreshes early: a token expiring inside the leeway is not reused", async () => {
  // expires_in 30s but the leeway is 60s → the cached token is never fresh.
  const h = harness(
    (call) => (call.url === TOKEN_URL ? tokenResponse("TKN", 30) : new Response("{}", { status: 200 })),
    { tokenLeewaySeconds: 60 },
  );
  await h.client.getBalance();
  await h.client.getBalance();
  assert.equal(h.calls.filter((c) => c.url === TOKEN_URL).length, 2);
});

test("a 401 triggers exactly one token refresh and one retry", async () => {
  let apiCalls = 0;
  const h = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse(`TKN${apiCalls}`);
    apiCalls++;
    if (apiCalls === 1) return new Response(JSON.stringify({ message: "expired" }), { status: 401 });
    return new Response(JSON.stringify({ balance: 10 }), { status: 200 });
  });

  const res = await h.client.getBalance();
  assert.deepEqual(res.data, { balance: 10 });
  assert.equal(apiCalls, 2, "the request is repeated once");
  assert.equal(h.calls.filter((c) => c.url === TOKEN_URL).length, 2, "the token is re-minted once");
});

test("a second 401 after the refresh throws instead of looping", async () => {
  let apiCalls = 0;
  const h = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse();
    apiCalls++;
    return new Response(JSON.stringify({ code: "unauthorized", message: "bad token" }), { status: 401 });
  });

  await assert.rejects(() => h.client.getBalance(), (err: unknown) => {
    assert.ok(err instanceof AvitoAdsError);
    assert.equal(err.status, 401);
    assert.equal(err.kind, "authentication");
    assert.equal(err.code, "unauthorized");
    return true;
  });
  assert.equal(apiCalls, 2, "one refresh + retry, then give up");
});

test("a failing token endpoint surfaces as an AvitoAdsError and is not cached", async () => {
  let tokenCalls = 0;
  const h = harness((call) => {
    if (call.url === TOKEN_URL) {
      tokenCalls++;
      if (tokenCalls === 1) return new Response(JSON.stringify({ message: "bad credentials" }), { status: 403 });
      return tokenResponse();
    }
    return new Response("{}", { status: 200 });
  });

  await assert.rejects(() => h.client.getBalance(), /OAuth2 token request failed: HTTP 403/);
  await h.client.getBalance(); // the failure was not cached, so a retry can succeed
  assert.equal(tokenCalls, 2);
});

test("a token response without access_token is rejected", async () => {
  const h = harness((call) =>
    call.url === TOKEN_URL
      ? new Response(JSON.stringify({ expires_in: 60 }), { status: 200 })
      : new Response("{}", { status: 200 }),
  );
  await assert.rejects(() => h.client.getBalance(), /no access_token/);
});

test("the token endpoint follows the api base, so a mock server serves both", async () => {
  const h = okHarness({ ok: true }, {}, { apiBase: "http://127.0.0.1:8080/ads/" });
  await h.client.getBalance();
  assert.equal(h.calls[0].url, "http://127.0.0.1:8080/token");
  assert.equal(h.calls[1].url, "http://127.0.0.1:8080/ads/v1/account/777/balance");
});

// --- Point balance ---

test("the Api-Point-Balance header rides back with every response", async () => {
  const h = okHarness({ balance: 1 }, { headers: { "Api-Point-Balance": "4832" } });
  const res = await h.client.getBalance();
  assert.equal(res.apiPointBalance, 4832);
  assert.deepEqual(res.data, { balance: 1 });
});

test("a missing or unparseable Api-Point-Balance reads as null, not 0", async () => {
  const absent = await okHarness({}).client.getBalance();
  assert.equal(absent.apiPointBalance, null);
  const junk = await okHarness({}, { headers: { "Api-Point-Balance": "n/a" } }).client.getBalance();
  assert.equal(junk.apiPointBalance, null);
});

test("the balance survives the reshaping list and array methods", async () => {
  const list = await okHarness(
    { total: 1, campaigns: [{ id: 5 }] },
    { headers: { "Api-Point-Balance": "10" } },
  ).client.listCampaigns();
  assert.equal(list.apiPointBalance, 10);

  const users = await okHarness({ users: [{ id: 1 }] }, { headers: { "Api-Point-Balance": "9" } }).client.listUsers();
  assert.equal(users.apiPointBalance, 9);
  assert.deepEqual(users.data, [{ id: 1 }]);
});

// --- Retries, timeout, SSRF ---

test("backoffMs honors Retry-After, caps it, and otherwise doubles", () => {
  const withRetryAfter = (v: string) => new Response("", { status: 429, headers: { "Retry-After": v } });
  assert.equal(backoffMs(0, 500, withRetryAfter("2")), 2000);
  assert.equal(backoffMs(0, 500, withRetryAfter("999")), 30_000, "a hostile Retry-After is capped at 30s");
  assert.equal(backoffMs(0, 500, withRetryAfter("later")), 500, "a non-numeric Retry-After falls back");
  assert.equal(backoffMs(0, 500), 500);
  assert.equal(backoffMs(1, 500), 1000);
  assert.equal(backoffMs(2, 500), 2000);
  assert.equal(backoffMs(20, 500), 30_000, "exponential growth is capped at 30s");
});

test("a 429 that never clears reports Retry-After and the point balance it failed with", async () => {
  const h = harness(
    (call) =>
      call.url === TOKEN_URL
        ? tokenResponse()
        : new Response(JSON.stringify({ code: "rate_limit", message: "weekly quota spent" }), {
            status: 429,
            headers: { "Retry-After": "3600", "Api-Point-Balance": "0" },
          }),
    { maxRetries: 0 },
  );

  await assert.rejects(() => h.client.listCampaigns(), (err: unknown) => {
    assert.ok(err instanceof AvitoAdsError);
    assert.equal(err.kind, "rate_limit");
    // Uncapped: the 30s cap belongs to the sleep, not to what the agent is told.
    assert.equal(err.retryAfter, 3600);
    assert.equal(err.apiPointBalance, 0);
    return true;
  });
});

test("an error without Retry-After or a balance header leaves both unset", async () => {
  const h = harness(
    (call) => (call.url === TOKEN_URL ? tokenResponse() : new Response(JSON.stringify({ message: "nope" }), { status: 400 })),
    { maxRetries: 0 },
  );
  await assert.rejects(() => h.client.listCampaigns(), (err: unknown) => {
    assert.ok(err instanceof AvitoAdsError);
    assert.equal(err.retryAfter, undefined);
    assert.equal(err.apiPointBalance, null);
    return true;
  });
});

test("reads retry 429 and 5xx, then return the result", async () => {
  for (const status of [429, 503]) {
    let apiCalls = 0;
    const h = harness((call) => {
      if (call.url === TOKEN_URL) return tokenResponse();
      apiCalls++;
      if (apiCalls === 1) return new Response("later", { status });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const res = await h.client.getBalance();
    assert.deepEqual(res.data, { ok: true }, `status ${status}`);
    assert.equal(apiCalls, 2, `status ${status}`);
  }
});

test("reads give up after maxRetries and never retry a 400", async () => {
  let apiCalls = 0;
  const h = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse();
    apiCalls++;
    return new Response("slow down", { status: 429 });
  });
  await assert.rejects(() => h.client.getBalance(), /HTTP 429/);
  assert.equal(apiCalls, 3, "initial + maxRetries(2)");

  apiCalls = 0;
  const bad = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse();
    apiCalls++;
    return new Response(JSON.stringify({ message: "nope" }), { status: 400 });
  });
  await assert.rejects(() => bad.client.getBalance(), (err: unknown) => {
    assert.ok(err instanceof AvitoAdsError);
    assert.equal(err.kind, "bad_request");
    return true;
  });
  assert.equal(apiCalls, 1);
});

test("writes retry a 429 but never a 5xx — a repeated transfer would move money twice", async () => {
  let apiCalls = 0;
  const rateLimited = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse();
    apiCalls++;
    if (apiCalls === 1) return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await rateLimited.client.transferFunds({ accountIdTo: 42, amount: 100 });
  assert.equal(apiCalls, 2, "429 was refused outright, so repeating it is safe");

  apiCalls = 0;
  const broken = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse();
    apiCalls++;
    return new Response("boom", { status: 502 });
  });
  await assert.rejects(() => broken.client.transferFunds({ accountIdTo: 42, amount: 100 }), /HTTP 502/);
  assert.equal(apiCalls, 1, "a 502 may mean the transfer committed — never repeat it");
});

test("reads retry a network error; writes rethrow it", async () => {
  let apiCalls = 0;
  const read = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse();
    apiCalls++;
    if (apiCalls === 1) throw new Error("ECONNRESET");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.deepEqual((await read.client.getBalance()).data, { ok: true });
  assert.equal(apiCalls, 2);

  apiCalls = 0;
  const write = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse();
    apiCalls++;
    throw new Error("ECONNRESET");
  });
  await assert.rejects(() => write.client.changeGroupBudget({ groupId: 1, budget: 500 }), /ECONNRESET/);
  assert.equal(apiCalls, 1);
});

test("a hanging request aborts and reports the timeout", async () => {
  const fetchImpl = ((url: unknown, init: RequestInit = {}) => {
    if (String(url) === TOKEN_URL) return Promise.resolve(tokenResponse());
    return new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
  }) as typeof fetch;
  const client = new AvitoAdsClient(
    { clientId: "c", clientSecret: "s", accountId: 1, environment: "production", apiBase: BASE, timeoutMs: 10, maxRetries: 0 },
    fetchImpl,
  );
  await assert.rejects(() => client.getBalance(), /timed out after 10ms/);
});

test("request() rejects any path that escapes the API base and never fetches it", async () => {
  const escapes = [
    "https://evil.example/steal",
    "http://evil.example/x",
    "\\\\evil.example/x", // backslashes are forward slashes to the URL parser
    "../token", // climbing out of /ads/ would replay the Bearer token at the credential endpoint
    "/../token",
    "/v1/../../token",
  ];
  for (const path of escapes) {
    const h = okHarness();
    await assert.rejects(
      () => h.client.request("POST", path, {}),
      /foreign origin|must stay under/,
      `must reject ${JSON.stringify(path)}`,
    );
    assert.equal(h.apiCalls.length, 0, `must not fetch for ${JSON.stringify(path)}`);
  }
});

test("request() refuses a path that addresses another account, however it is spelled", async () => {
  // The account id is config, never an argument: raw_request must not be able to
  // reach funds-transfer or delete-user on someone else's account.
  const foreign = [
    "v1/account/999/funds-transfer",
    "v1/account/777/../../account/999/funds-transfer", // normalises to the same url
    "v1/account/%399/balance", // percent-encoded "99"
    "V1/Account/999/balance", // the API path is matched case-insensitively
    "v1/account/999",
  ];
  for (const path of foreign) {
    const h = okHarness();
    await assert.rejects(
      () => h.client.request("POST", path, {}),
      /must address the configured account 777/,
      `must reject ${JSON.stringify(path)}`,
    );
    assert.equal(h.apiCalls.length, 0, `must not fetch for ${JSON.stringify(path)}`);
  }
});

test("request() still accepts the configured account and non-account paths", async () => {
  const h = okHarness();
  await h.client.request("GET", "v1/account/777/balance");
  await h.client.request("GET", "v1/dictionaries/regions"); // not account-scoped
  assert.deepEqual(h.apiCalls.map((c) => c.url), [
    `${BASE}v1/account/777/balance`,
    `${BASE}v1/dictionaries/regions`,
  ]);
});

test("a protocol-relative path is neutralized into a path under the base, not honored", async () => {
  const h = okHarness();
  await h.client.request("POST", "//evil.example/x", {});
  assert.equal(h.apiCalls[0].url, `${BASE}evil.example/x`);
});

test("request() accepts a relative API path and returns data + balance", async () => {
  const h = okHarness({ ok: true }, { headers: { "Api-Point-Balance": "7" } });
  const res = await h.client.request("POST", "v1/account/777/campaigns", { limit: 5 });
  assert.deepEqual(res, { data: { ok: true }, apiPointBalance: 7 });
  assert.equal(h.apiCalls[0].url, `${BASE}v1/account/777/campaigns`);
  assert.equal(h.apiCalls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(h.apiCalls[0].body, { limit: 5 });
});

test("a GET carries no body and no Content-Type", async () => {
  const h = okHarness();
  await h.client.getBalance();
  assert.equal(h.apiCalls[0].body, undefined);
  assert.equal(h.apiCalls[0].headers["Content-Type"], undefined);
});

test("the error taxonomy follows the status code", async () => {
  const cases: Array<[number, string]> = [
    [400, "bad_request"],
    [401, "authentication"],
    [403, "access_denied"],
    [404, "not_found"],
    [429, "rate_limit"],
    [500, "server"],
    [418, "api"],
  ];
  for (const [status, kind] of cases) {
    const h = harness(
      (call) => (call.url === TOKEN_URL ? tokenResponse() : new Response(JSON.stringify({ message: "x" }), { status })),
      { maxRetries: 0 },
    );
    await assert.rejects(() => h.client.listCampaigns(), (err: unknown) => {
      assert.ok(err instanceof AvitoAdsError, `${status} must throw AvitoAdsError`);
      assert.equal(err.status, status);
      assert.equal(err.kind, kind);
      return true;
    });
  }
});

// --- Pagination ---

test("normalizeListRequest clamps limit to 1..100 and page to >= 1", () => {
  assert.deepEqual(normalizeListRequest(), { filter: {}, limit: 20, page: 1 });
  assert.equal(normalizeListRequest({ limit: 500 }).limit, 100);
  assert.equal(normalizeListRequest({ limit: 0 }).limit, 1);
  assert.equal(normalizeListRequest({ limit: -7 }).limit, 1);
  assert.equal(normalizeListRequest({ limit: 12.9 }).limit, 12);
  assert.equal(normalizeListRequest({ limit: Number.NaN }).limit, 20);
  assert.equal(normalizeListRequest({ page: 0 }).page, 1);
  assert.equal(normalizeListRequest({ page: -3 }).page, 1);
  assert.equal(normalizeListRequest({ page: 4 }).page, 4);
  assert.deepEqual(normalizeListRequest({ filter: { ids: [1] } }).filter, { ids: [1] });
});

test("list endpoints POST filter/limit/page and report the page shape", async () => {
  const h = okHarness({ total: 250, campaigns: [{ id: 1 }, { id: 2 }] });
  const res = await h.client.listCampaigns({ filter: { statuses: ["active"] }, limit: 999, page: 2 });

  assert.equal(h.apiCalls[0].url, `${BASE}v1/account/777/campaigns`);
  assert.equal(h.apiCalls[0].method, "POST");
  assert.deepEqual(h.apiCalls[0].body, { filter: { statuses: ["active"] }, limit: 100, page: 2 });
  assert.deepEqual(res.data, {
    total: 250,
    items: [{ id: 1 }, { id: 2 }],
    page: 2,
    limit: 100,
    hasNextPage: true,
  });
});

test("hasNextPage goes false on the last page, and a missing items key reads as empty", async () => {
  const last = await okHarness({ total: 3, groups: [{ id: 1 }] }).client.listGroups({ page: 3, limit: 1 });
  assert.equal(last.data.hasNextPage, false);

  const empty = await okHarness({ total: 0 }).client.listCreatives();
  assert.deepEqual(empty.data.items, []);
  assert.equal(empty.data.hasNextPage, false);
});

// --- Paths and bodies ---

test("every account-scoped path is built from the configured account id", async () => {
  const seen: Array<[string, string, unknown]> = [];
  const h = harness((call) => {
    if (call.url === TOKEN_URL) return tokenResponse();
    seen.push([call.method, call.url.replace(BASE, ""), call.body]);
    return new Response(JSON.stringify({ total: 0 }), { status: 200 });
  });
  const c = h.client;

  await c.getAccount();
  await c.getBalance();
  await c.listChildAccounts();
  await c.listChildAccountsWithBalances();
  await c.createNonpayerChildAccount({ shortName: "Sub", isSelfAdvertisingEnabled: true });
  await c.transferFunds({ accountIdTo: 42, amount: 500 });
  await c.transferBonus({ accountIdTo: 42, amount: 10 });
  await c.listAdvertisers();
  await c.listContracts();
  await c.listCampaigns();
  await c.listGroups();
  await c.changeGroupBudget({ groupId: 8, budget: 1000 });
  await c.changeGroupPrice({ groupId: 8, price: 25 });
  await c.listCreatives();
  await c.campaignStats({ campaignId: 3, dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  await c.groupStats({ campaignId: 3, dateFrom: "2026-01-01", dateTo: "2026-01-31", groupIds: [8] });
  await c.creativeStats({ campaignId: 3, dateFrom: "2026-01-01", dateTo: "2026-01-31", creativeIds: [9] });
  await c.listUsers();
  await c.addUser({ userId: 5, role: "viewer" });
  await c.setUserRole({ userId: 5, role: "admin" });
  await c.deleteUser(5);

  assert.deepEqual(seen.map(([m, p]) => `${m} ${p}`), [
    "GET v1/account/777",
    "GET v1/account/777/balance",
    "GET v1/account/777/children",
    "GET v1/account/777/children-with-balances",
    "POST v1/account/777/create-nonpayer-child-account",
    "POST v1/account/777/funds-transfer",
    "POST v1/account/777/bonus-transfer",
    "POST v1/account/777/advertisers",
    "POST v1/account/777/contracts",
    "POST v1/account/777/campaigns",
    "POST v1/account/777/groups",
    "POST v1/account/777/group/8/change-budget",
    "POST v1/account/777/group/8/change-price",
    "POST v1/account/777/creatives",
    "POST v1/account/777/campaigns/3/stats",
    "POST v1/account/777/campaigns/3/groups/stats",
    "POST v1/account/777/campaigns/3/creatives/stats",
    "GET v1/account/777/users",
    "POST v1/account/777/add-user",
    "POST v1/account/777/set-user-role",
    "DELETE v1/account/777/delete-user/5",
  ]);

  const bodyOf = (path: string) => seen.find(([, p]) => p === path)?.[2];
  assert.deepEqual(bodyOf("v1/account/777/create-nonpayer-child-account"), {
    shortName: "Sub",
    isSelfAdvertisingEnabled: true,
  });
  assert.deepEqual(bodyOf("v1/account/777/funds-transfer"), { accountIdTo: 42, amount: 500 });
  assert.deepEqual(bodyOf("v1/account/777/bonus-transfer"), { accountIdTo: 42, amount: 10 });
  assert.deepEqual(bodyOf("v1/account/777/group/8/change-budget"), { budget: 1000 });
  assert.deepEqual(bodyOf("v1/account/777/group/8/change-price"), { price: 25 });
  assert.deepEqual(bodyOf("v1/account/777/campaigns/3/stats"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  assert.deepEqual(bodyOf("v1/account/777/campaigns/3/groups/stats"), {
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    groupIDs: [8],
  });
  assert.deepEqual(bodyOf("v1/account/777/campaigns/3/creatives/stats"), {
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    creativeIDs: [9],
  });
  assert.deepEqual(bodyOf("v1/account/777/add-user"), { userId: 5, role: "viewer" });
  assert.deepEqual(bodyOf("v1/account/777/set-user-role"), { userId: 5, role: "admin" });
  assert.equal(bodyOf("v1/account/777/delete-user/5"), undefined);
});

test("the sandbox environment moves every path under /ads-sandbox/", async () => {
  const h = okHarness({}, {}, { apiBase: "https://api.avito.ru/ads-sandbox/", environment: "sandbox" });
  await h.client.getBalance();
  assert.equal(h.apiCalls[0].url, "https://api.avito.ru/ads-sandbox/v1/account/777/balance");
  assert.equal(h.client.environment, "sandbox");
  assert.equal(h.client.accountId, 777);
  assert.equal(h.client.accountPath("users"), "v1/account/777/users");
});

test("getAccount unwraps both the wrapped and the flat response shape", async () => {
  const wrapped = await okHarness({ account: { inn: "123" } }).client.getAccount();
  assert.deepEqual(wrapped.data, { inn: "123" });
  const flat = await okHarness({ inn: "456" }).client.getAccount();
  assert.deepEqual(flat.data, { inn: "456" });
});

test("array-valued endpoints unwrap their key and default to an empty list", async () => {
  assert.deepEqual((await okHarness({ children: [{ account: { id: 2 } }] }).client.listChildAccounts()).data, [
    { account: { id: 2 } },
  ]);
  assert.deepEqual((await okHarness({}).client.listChildAccountsWithBalances()).data, []);
  assert.deepEqual((await okHarness({ groups: [{ id: 1 }] }).client.groupStats({
    campaignId: 1,
    dateFrom: "2026-01-01",
    dateTo: "2026-01-02",
    groupIds: [1],
  })).data, [{ id: 1 }]);
  assert.deepEqual((await okHarness({}).client.creativeStats({
    campaignId: 1,
    dateFrom: "2026-01-01",
    dateTo: "2026-01-02",
    creativeIds: [9],
  })).data, []);
});

test("stats id lists are sent exactly as given — no empty-list default is invented", async () => {
  // The SDK makes the id list a required argument and documents no meaning for
  // an empty one, so the client never substitutes `[]` on the caller's behalf.
  const h = okHarness({});
  await h.client.groupStats({ campaignId: 3, dateFrom: "2026-01-01", dateTo: "2026-01-02", groupIds: [8, 9] });
  assert.deepEqual(h.apiCalls[0].body, { dateFrom: "2026-01-01", dateTo: "2026-01-02", groupIDs: [8, 9] });

  const c = okHarness({});
  await c.client.creativeStats({ campaignId: 3, dateFrom: "2026-01-01", dateTo: "2026-01-02", creativeIds: [] });
  assert.deepEqual(c.apiCalls[0].body, { dateFrom: "2026-01-01", dateTo: "2026-01-02", creativeIDs: [] });
});

// --- Client-side validation ---

/** Asserts the call is rejected before any request leaves the process. */
async function rejectsWithoutFetching(run: (c: AvitoAdsClient) => Promise<unknown>, pattern: RegExp): Promise<void> {
  const h = okHarness();
  await assert.rejects(
    () => run(h.client),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
      assert.match(err.message, pattern);
      return true;
    },
  );
  assert.equal(h.calls.length, 0, "a rejected input must not spend an API point");
}

test("budget, price and transfer amounts below 1 are rejected up front", async () => {
  await rejectsWithoutFetching((c) => c.changeGroupBudget({ groupId: 1, budget: 0 }), /budget must be at least 1/);
  await rejectsWithoutFetching((c) => c.changeGroupPrice({ groupId: 1, price: 0.5 }), /price must be at least 1/);
  await rejectsWithoutFetching((c) => c.transferFunds({ accountIdTo: 2, amount: 0 }), /amount must be at least 1/);
  await rejectsWithoutFetching((c) => c.transferBonus({ accountIdTo: 2, amount: -5 }), /amount must be at least 1/);
  await rejectsWithoutFetching(
    (c) => c.changeGroupBudget({ groupId: 1, budget: Number.NaN }),
    /budget must be at least 1/,
  );
});

test("statistics periods must be well-formed and at most 100 days", async () => {
  const period = (dateFrom: string, dateTo: string) => (c: AvitoAdsClient) =>
    c.campaignStats({ campaignId: 1, dateFrom, dateTo });
  await rejectsWithoutFetching(period("01.01.2026", "2026-01-31"), /YYYY-MM-DD/);
  await rejectsWithoutFetching(period("2026-01-01", "31 Jan 2026"), /YYYY-MM-DD/);
  await rejectsWithoutFetching(period("2026-02-31", "2026-03-01"), /real calendar dates/);
  await rejectsWithoutFetching(period("2026-03-01", "2026-01-01"), /must not be later than/);
  await rejectsWithoutFetching(period("2026-01-01", "2026-04-11"), /must not exceed 100 days/);
  await rejectsWithoutFetching(
    (c) => c.groupStats({ campaignId: 1, dateFrom: "2026-01-01", dateTo: "2027-01-01", groupIds: [1] }),
    /must not exceed 100 days/,
  );
  await rejectsWithoutFetching(
    (c) => c.creativeStats({ campaignId: 1, dateFrom: "bad", dateTo: "2026-01-02", creativeIds: [1] }),
    /YYYY-MM-DD/,
  );

  // Exactly 100 days inclusive is allowed and goes out.
  const h = okHarness({});
  await h.client.campaignStats({ campaignId: 1, dateFrom: "2026-01-01", dateTo: "2026-04-10" });
  assert.equal(h.apiCalls.length, 1);
});

test("unknown user roles are rejected before the request", async () => {
  await rejectsWithoutFetching(
    (c) => c.addUser({ userId: 1, role: "owner" as never }),
    /role must be one of admin, viewer/,
  );
  await rejectsWithoutFetching(
    (c) => c.setUserRole({ userId: 1, role: "" as never }),
    /role must be one of admin, viewer/,
  );
});

test("creating a sandbox account without contact details is rejected", async () => {
  const input = {
    inn: "1",
    shortName: "s",
    longName: "l",
    ogrn: "o",
    legalAddress: "a",
    actualAddress: "a",
    contact: {},
  };
  await rejectsWithoutFetching((c) => c.createSandboxAccount(input), /contact is required/);

  const h = okHarness({ accountID: 5 });
  const res = await h.client.createSandboxAccount({ ...input, contact: { email: "a@b.c" } });
  assert.deepEqual(res.data, { accountID: 5 });
  assert.equal(h.apiCalls[0].url, `${BASE}v1/account/777`);
});

test("createNonpayerChildAccount requires a name", async () => {
  await rejectsWithoutFetching(
    (c) => c.createNonpayerChildAccount({ shortName: "", isSelfAdvertisingEnabled: false }),
    /shortName is required/,
  );
});

test("validateContractInput enforces the per-type rules", () => {
  const base: ContractInput = {
    advertiserId: 1,
    type: "service",
    description: "direct_with_advertiser",
    subject: "distribution",
    isReportingRequired: true,
    date: "2026-01-01",
    number: "A-1",
    intermediary: { inn: "1" },
  };
  assert.doesNotThrow(() => validateContractInput(base));

  const rejects = (input: ContractInput, pattern: RegExp) =>
    assert.throws(() => validateContractInput(input), (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, pattern);
      return true;
    });

  rejects({ ...base, number: undefined }, /requires subject, isReportingRequired, date and number/);
  rejects({ ...base, cid: "X" }, /cannot carry cid/);
  rejects({ ...base, date: "01.01.2026" }, /YYYY-MM-DD/);
  rejects({ ...base, intermediary: undefined }, /intermediary .* is required unless parentId/);
  rejects({ ...base, parentId: 9 }, /additional agreement .* cannot carry intermediary/);
  assert.doesNotThrow(() => validateContractInput({ ...base, parentId: 9, intermediary: undefined }));

  // intermediary contracts need object + isFundsAllocationToPrincipal on top
  rejects({ ...base, type: "intermediary" }, /requires object/);
  assert.doesNotThrow(() =>
    validateContractInput({
      ...base,
      type: "intermediary",
      object: "distribution",
      isFundsAllocationToPrincipal: true,
    }),
  );

  // external contracts need cid and reject parentId
  const external: ContractInput = { advertiserId: 1, type: "external", description: "advertiser_intermediary", intermediary: {} };
  rejects(external, /requires cid/);
  rejects({ ...external, cid: "C-1", parentId: 2 }, /cannot carry parentId/);
  assert.doesNotThrow(() => validateContractInput({ ...external, cid: "C-1" }));
});

test("createContract validates before spending an API point, then posts the body", async () => {
  await rejectsWithoutFetching(
    (c) => c.createContract({ advertiserId: 1, type: "external", description: "direct_with_advertiser" }),
    /requires cid/,
  );

  const h = okHarness({ id: 77 });
  const res = await h.client.createContract({
    advertiserId: 1,
    type: "external",
    description: "direct_with_advertiser",
    cid: "C-1",
    intermediary: { inn: "5" },
  });
  assert.deepEqual(res.data, { id: 77 });
  assert.equal(h.apiCalls[0].url, `${BASE}v1/account/777/create-contract`);
  assert.deepEqual(h.apiCalls[0].body, {
    advertiserId: 1,
    type: "external",
    description: "direct_with_advertiser",
    cid: "C-1",
    intermediary: { inn: "5" },
  });
});

test("createAdvertiser posts the payload without undefined keys", async () => {
  const h = okHarness({ id: 3 });
  await h.client.createAdvertiser({
    inn: "1",
    shortName: "s",
    longName: "l",
    ogrn: "o",
    legalAddress: "a",
    actualAddress: "b",
    legalRole: "rd",
    legalType: "ul",
    kpp: undefined,
  });
  assert.deepEqual(h.apiCalls[0].body, {
    inn: "1",
    shortName: "s",
    longName: "l",
    ogrn: "o",
    legalAddress: "a",
    actualAddress: "b",
    legalRole: "rd",
    legalType: "ul",
  });
});
