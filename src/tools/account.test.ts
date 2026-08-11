import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ValidationError } from "../types.js";
import { registerAccountTools } from "./account.js";

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
  inputSchema?: z.ZodRawShape;
}

/** Fake server + fake client, so the handlers run with no network and no McpServer. */
function harness(opts: { throwOn?: string; environment?: string } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const make = (method: string, data: unknown) => async (params?: unknown) => {
    calls.push({ method, params });
    if (opts.throwOn === method) throw new ValidationError("contact is required when creating an account.");
    return { data, apiPointBalance: 4832 };
  };
  const client = {
    // create_sandbox_account is gated on this, so the default is the sandbox.
    environment: opts.environment ?? "sandbox",
    getAccount: make("getAccount", { inn: "7712345678", shortName: "OOO Romashka" }),
    getBalance: make("getBalance", { balance: 15000, bonusBalance: 250 }),
    createSandboxAccount: make("createSandboxAccount", { accountID: 991 }),
  };
  const configs: Record<string, ToolConfig> = {};
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, cfg: ToolConfig, handler: Handler) => {
      configs[name] = cfg;
      tools[name] = handler;
    },
  };
  registerAccountTools(server as never, client as never);
  return { calls, configs, tools };
}

/** Valid arguments for create_sandbox_account; individual tests override fields. */
const SANDBOX_ARGS = {
  inn: "7712345678",
  shortName: "OOO Romashka",
  longName: "Obshchestvo s ogranichennoy otvetstvennostyu Romashka",
  ogrn: "1027700132195",
  legalAddress: "Moscow, Lenina 1",
  actualAddress: "Moscow, Lenina 1",
  contact: { name: "Ivan Ivanov", email: "ivan@example.com" },
};

test("registers the three account tools", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), ["create_sandbox_account", "get_account", "get_balance"]);
});

test("the two readers are read-only; creating an account is a non-idempotent write", () => {
  const { configs } = harness();
  for (const name of ["get_account", "get_balance"]) {
    assert.deepEqual(configs[name].annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    }, `${name} must be annotated read-only`);
  }
  // Creating twice creates two accounts, so it is a write and not idempotent —
  // but it destroys nothing, so destructiveHint stays false.
  assert.deepEqual(configs.create_sandbox_account.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("the readers take no arguments — the account id comes from config", () => {
  const { configs } = harness();
  assert.deepEqual(configs.get_account.inputSchema, {});
  assert.deepEqual(configs.get_balance.inputSchema, {});
  assert.ok(!("accountId" in (configs.create_sandbox_account.inputSchema ?? {})));
});

test("create_sandbox_account is described as sandbox-only", () => {
  const { configs } = harness();
  assert.match(configs.create_sandbox_account.description ?? "", /sandbox only/i);
  assert.match(configs.create_sandbox_account.description ?? "", /AVITO_ADS_ENVIRONMENT=sandbox/);
});

test("create_sandbox_account refuses to run against production, before any request", async () => {
  // POST v1/account/{accountID} posts legal-entity details to the *configured*
  // account's endpoint; nothing in the SDK promises production would refuse it.
  const { calls, tools } = harness({ environment: "production" });
  const res = await tools.create_sandbox_account(SANDBOX_ARGS);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /only against the sandbox/);
  assert.match(res.content[0].text, /AVITO_ADS_ENVIRONMENT=sandbox/);
  assert.equal(calls.length, 0, "a refused call must not spend an API point");
});

test("get_account calls the client with no arguments and passes the envelope through", async () => {
  const { calls, tools } = harness();
  const res = await tools.get_account({});
  assert.equal(calls[0].method, "getAccount");
  assert.equal(calls[0].params, undefined);
  assert.deepEqual(JSON.parse(res.content[0].text), {
    data: { inn: "7712345678", shortName: "OOO Romashka" },
    apiPointBalance: 4832,
  });
});

test("get_balance returns rubles and bonus rubles with the remaining point quota", async () => {
  const { calls, tools } = harness();
  const res = await tools.get_balance({});
  assert.equal(calls[0].method, "getBalance");
  // Compact JSON: no spaces, no newlines — the consumer is an LLM.
  assert.equal(res.content[0].text, '{"data":{"balance":15000,"bonusBalance":250},"apiPointBalance":4832}');
});

test("create_sandbox_account forwards every field, optional ones included", async () => {
  const { calls, tools } = harness();
  await tools.create_sandbox_account({ ...SANDBOX_ARGS, kpp: "771201001", legalType: "ul" });
  assert.equal(calls[0].method, "createSandboxAccount");
  assert.deepEqual(calls[0].params, { ...SANDBOX_ARGS, kpp: "771201001", legalType: "ul" });
});

test("create_sandbox_account leaves omitted optionals undefined for the client to drop", async () => {
  const { calls, tools } = harness();
  const res = await tools.create_sandbox_account(SANDBOX_ARGS);
  const params = calls[0].params as Record<string, unknown>;
  assert.equal(params.kpp, undefined);
  assert.equal(params.legalType, undefined);
  assert.deepEqual(params.contact, SANDBOX_ARGS.contact);
  assert.deepEqual(JSON.parse(res.content[0].text), { data: { accountID: 991 }, apiPointBalance: 4832 });
});

test("the input schema rejects an empty or missing contact", () => {
  const { configs } = harness();
  const schema = z.object(configs.create_sandbox_account.inputSchema ?? {});
  assert.equal(schema.safeParse(SANDBOX_ARGS).success, true);
  assert.equal(schema.safeParse({ ...SANDBOX_ARGS, contact: {} }).success, false);
  assert.equal(schema.safeParse({ ...SANDBOX_ARGS, contact: undefined }).success, false);
  assert.equal(schema.safeParse({ ...SANDBOX_ARGS, contact: "Ivan" }).success, false);
});

test("the input schema rejects blank legal details and an unknown legal type", () => {
  const { configs } = harness();
  const schema = z.object(configs.create_sandbox_account.inputSchema ?? {});
  assert.equal(schema.safeParse({ ...SANDBOX_ARGS, inn: "" }).success, false);
  assert.equal(schema.safeParse({ ...SANDBOX_ARGS, shortName: "" }).success, false);
  assert.equal(schema.safeParse({ ...SANDBOX_ARGS, legalType: "ooo" }).success, false);
  assert.equal(schema.safeParse({ ...SANDBOX_ARGS, legalType: "ip" }).success, true);
});

test("a client rejection is returned as an isError result, not thrown", async () => {
  const { tools } = harness({ throwOn: "createSandboxAccount" });
  const res = await tools.create_sandbox_account({ ...SANDBOX_ARGS, contact: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /contact is required/);
});
