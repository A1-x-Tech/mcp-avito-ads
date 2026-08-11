import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerOrdTools } from "./ord.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface Registered {
  annotations?: Annotations;
  schema: z.ZodRawShape;
  handler: Handler;
}

/** Fake server + fake client, so the handlers run without a network or an McpServer. */
function harness(opts: { throwOn?: string } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const make =
    (method: string, result: unknown) =>
    async (params?: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (opts.throwOn === method) throw new Error("boom");
      return result;
    };

  const page = (items: unknown[]) => ({
    data: { total: items.length, items, page: 1, limit: 20, hasNextPage: false },
    apiPointBalance: 4242,
  });

  const client = {
    createAdvertiser: make("createAdvertiser", { data: { id: 42 }, apiPointBalance: 4242 }),
    listAdvertisers: make("listAdvertisers", page([{ id: 42, shortName: "ООО Реклама" }])),
    createContract: make("createContract", { data: { id: 7 }, apiPointBalance: 4241 }),
    listContracts: make("listContracts", page([{ id: 7, number: "ДА-2025/01" }])),
  };

  const tools: Record<string, Registered> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Annotations; inputSchema: z.ZodRawShape }, handler: Handler) => {
      tools[name] = { annotations: cfg.annotations, schema: cfg.inputSchema, handler };
    },
  };
  registerOrdTools(server as never, client as never);
  return { calls, tools };
}

/** Runs args through a tool's declared input schema, the way the McpServer does. */
function parse(tools: Record<string, Registered>, name: string, args: Args) {
  return z.object(tools[name].schema).safeParse(args);
}

const ADVERTISER: Args = {
  inn: "7712345678",
  shortName: "ООО Реклама",
  longName: "Общество с ограниченной ответственностью «Реклама»",
  ogrn: "1177746123456",
  legalAddress: "г. Москва, ул. Примерная, д. 1",
  actualAddress: "г. Москва, ул. Примерная, д. 1",
  legalRole: "rd",
  legalType: "ul",
  kpp: "771701001",
};

const CONTRACT: Args = {
  advertiserId: 987654321,
  type: "intermediary",
  counterpartyType: "direct_with_advertiser",
  subject: "mediation",
  object: "commercial",
  isReportingRequired: true,
  isFundsAllocationToPrincipal: false,
  date: "2025-01-15",
  number: "ДА-2025/01",
  intermediary: { inn: "7712345678", shortName: "ООО Реклама", legalType: "ul" },
};

test("registers the four ORD tools", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), [
    "create_advertiser",
    "create_contract",
    "list_advertisers",
    "list_contracts",
  ]);
});

test("lists are read-only, creates are non-idempotent writes, and nothing here is destructive", () => {
  const { tools } = harness();
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.annotations, `${name} is missing annotations`);
    // Registering ORD paperwork never removes anything, so no tool may be
    // flagged destructive — the money-moving tools live in another module.
    assert.equal(tool.annotations?.destructiveHint, false, `${name} must not be destructive`);
    assert.equal(tool.annotations?.openWorldHint, true, `${name} must set openWorldHint`);
  }
  for (const name of ["list_advertisers", "list_contracts"]) {
    assert.equal(tools[name].annotations?.readOnlyHint, true, `${name} should be read-only`);
    assert.equal(tools[name].annotations?.idempotentHint, true, `${name} should be idempotent`);
  }
  for (const name of ["create_advertiser", "create_contract"]) {
    assert.equal(tools[name].annotations?.readOnlyHint, false, `${name} writes`);
    // Repeating a create registers a duplicate counterparty/contract, and there
    // is no delete endpoint to undo it.
    assert.equal(tools[name].annotations?.idempotentHint, false, `${name} is not idempotent`);
  }
});

test("create_advertiser forwards the legal details verbatim", async () => {
  const { calls, tools } = harness();
  const res = await tools.create_advertiser.handler(ADVERTISER);
  assert.equal(calls[0].method, "createAdvertiser");
  assert.deepEqual(calls[0].params, ADVERTISER);
  assert.equal(res.isError, undefined);
  // The whole envelope rides along, so the agent sees the weekly point balance.
  assert.deepEqual(JSON.parse(res.content[0].text), { data: { id: 42 }, apiPointBalance: 4242 });
});

test("create_advertiser: kpp is optional, and the enums are closed", () => {
  const { tools } = harness();
  const { kpp, ...noKpp } = ADVERTISER;
  assert.equal(kpp, "771701001");
  assert.equal(parse(tools, "create_advertiser", noKpp).success, true);
  assert.equal(parse(tools, "create_advertiser", { ...ADVERTISER, legalRole: "advertiser" }).success, false);
  assert.equal(parse(tools, "create_advertiser", { ...ADVERTISER, legalType: "ooo" }).success, false);
  // inn/shortName/longName/ogrn/addresses/legalRole/legalType are all required.
  const { inn, ...noInn } = ADVERTISER;
  assert.equal(inn, "7712345678");
  assert.equal(parse(tools, "create_advertiser", noInn).success, false);
});

test("create_contract renames counterpartyType to the API's description field", async () => {
  const { calls, tools } = harness();
  await tools.create_contract.handler(CONTRACT);
  assert.equal(calls[0].method, "createContract");
  const params = calls[0].params as Record<string, unknown>;
  assert.equal(params.description, "direct_with_advertiser");
  assert.equal("counterpartyType" in params, false);
  assert.deepEqual(params, {
    advertiserId: 987654321,
    type: "intermediary",
    description: "direct_with_advertiser",
    subject: "mediation",
    object: "commercial",
    cid: undefined,
    date: "2025-01-15",
    number: "ДА-2025/01",
    isReportingRequired: true,
    isFundsAllocationToPrincipal: false,
    parentId: undefined,
    intermediary: { inn: "7712345678", shortName: "ООО Реклама", legalType: "ul" },
  });
});

test("create_contract accepts an external contract and an additional agreement", () => {
  const { tools } = harness();
  assert.equal(
    parse(tools, "create_contract", {
      advertiserId: 1,
      type: "external",
      counterpartyType: "advertiser_intermediary",
      cid: "CID-1",
      intermediary: { inn: "1" },
    }).success,
    true,
  );
  assert.equal(
    parse(tools, "create_contract", {
      advertiserId: 1,
      type: "service",
      counterpartyType: "direct_with_advertiser",
      subject: "distribution",
      isReportingRequired: false,
      date: "2025-02-01",
      number: "1",
      parentId: 99,
    }).success,
    true,
  );
});

test("create_contract schema rejects unknown vocabulary and malformed dates", () => {
  const { tools } = harness();
  for (const bad of [
    { type: "agency" },
    { counterpartyType: "direct" },
    { subject: "advertising" },
    { object: "conclusion" },
    { date: "15.01.2025" },
    { date: "2025-1-15" },
    { advertiserId: 0 },
    { advertiserId: "987654321" },
    { parentId: -1 },
  ]) {
    const args = { ...CONTRACT, ...bad };
    assert.equal(parse(tools, "create_contract", args).success, false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test("create_contract keeps unknown intermediary fields instead of dropping them", () => {
  const { tools } = harness();
  const parsed = parse(tools, "create_contract", {
    ...CONTRACT,
    intermediary: { inn: "1", mobilePhone: "+79990000000" },
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success && parsed.data.intermediary, { inn: "1", mobilePhone: "+79990000000" });
});

test("the per-type contract rules are the client's job, not the schema's", async () => {
  // An intermediary contract with no subject/date/number is schema-valid: the
  // client's validateContractInput is the single place those rules live.
  const { calls, tools } = harness();
  const minimal = { advertiserId: 1, type: "intermediary", counterpartyType: "direct_with_advertiser" };
  assert.equal(parse(tools, "create_contract", minimal).success, true);
  await tools.create_contract.handler(minimal);
  assert.equal(calls[0].method, "createContract");
});

test("list tools forward filter, limit and page to the client", async () => {
  const { calls, tools } = harness();
  await tools.list_advertisers.handler({ filter: { inns: ["7712345678"], roles: ["ra"] }, limit: 50, page: 2 });
  await tools.list_contracts.handler({ filter: { clients: [42] } });
  assert.equal(calls[0].method, "listAdvertisers");
  assert.deepEqual(calls[0].params, { filter: { inns: ["7712345678"], roles: ["ra"] }, limit: 50, page: 2 });
  assert.equal(calls[1].method, "listContracts");
  assert.deepEqual(calls[1].params, { filter: { clients: [42] }, limit: undefined, page: undefined });
});

test("list tools return the page envelope with the point balance", async () => {
  const { tools } = harness();
  const res = await tools.list_contracts.handler({});
  assert.deepEqual(JSON.parse(res.content[0].text), {
    data: { total: 1, items: [{ id: 7, number: "ДА-2025/01" }], page: 1, limit: 20, hasNextPage: false },
    apiPointBalance: 4242,
  });
});

test("list schemas clamp nothing but reject out-of-range paging", () => {
  const { tools } = harness();
  for (const name of ["list_advertisers", "list_contracts"]) {
    assert.equal(parse(tools, name, {}).success, true, `${name} takes no arguments at all`);
    assert.equal(parse(tools, name, { limit: 100, page: 1 }).success, true);
    assert.equal(parse(tools, name, { limit: 0 }).success, false);
    assert.equal(parse(tools, name, { limit: 101 }).success, false);
    assert.equal(parse(tools, name, { page: 0 }).success, false);
    assert.equal(parse(tools, name, { limit: 10.5 }).success, false);
  }
  // Filter keys the SDK does not know are passed through, not stripped.
  const parsed = parse(tools, "list_contracts", { filter: { ids: [1], somethingNew: true } });
  assert.deepEqual(parsed.success && parsed.data.filter, { ids: [1], somethingNew: true });
});

test("a client error is returned as an isError result, not thrown", async () => {
  const { tools } = harness({ throwOn: "createContract" });
  const res = await tools.create_contract.handler(CONTRACT);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
});
