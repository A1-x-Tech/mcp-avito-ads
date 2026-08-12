import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerChildAccountTools } from "./child-accounts.js";

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
  inputSchema?: Record<string, z.ZodTypeAny>;
}

/** Fake server + fake client, so the handlers run without a network or a real client. */
function harness(opts: { throwOn?: string } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const make = (method: string) => async (params?: unknown) => {
    calls.push({ method, params });
    if (opts.throwOn === method) throw new Error("boom");
    return { data: { called: method }, apiPointBalance: 4832 };
  };
  const client = {
    listChildAccounts: make("listChildAccounts"),
    listChildAccountsWithBalances: make("listChildAccountsWithBalances"),
    createNonpayerChildAccount: make("createNonpayerChildAccount"),
    transferFunds: make("transferFunds"),
    transferBonus: make("transferBonus"),
  };
  const tools: Record<string, Handler> = {};
  const configs: Record<string, ToolConfig> = {};
  const server = {
    registerTool: (name: string, cfg: ToolConfig, handler: Handler) => {
      configs[name] = cfg;
      tools[name] = handler;
    },
  };
  registerChildAccountTools(server as never, client as never);
  return { calls, tools, configs };
}

/** Rebuilds the zod object the McpServer would validate arguments against. */
function schemaOf(cfg: ToolConfig) {
  return z.object(cfg.inputSchema ?? {});
}

test("registers the five child-account tools", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), [
    "create_child_account",
    "list_child_accounts",
    "list_child_accounts_with_balances",
    "transfer_bonus",
    "transfer_funds",
  ]);
});

test("the two list tools are read-only and take no arguments", () => {
  const { configs } = harness();
  for (const name of ["list_child_accounts", "list_child_accounts_with_balances"]) {
    assert.deepEqual(
      configs[name].annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      `${name} should be READ_ONLY`,
    );
    assert.deepEqual(Object.keys(configs[name].inputSchema ?? {}), [], `${name} takes no input`);
  }
});

test("create_child_account writes but is neither destructive nor idempotent", () => {
  const { configs } = harness();
  assert.deepEqual(configs.create_child_account.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
});

test("both money-moving tools are marked destructive with all four hints", () => {
  const { configs } = harness();
  for (const name of ["transfer_funds", "transfer_bonus"]) {
    assert.deepEqual(
      configs[name].annotations,
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      `${name} must be DESTRUCTIVE — it moves real funds`,
    );
  }
});

test("the transfer descriptions say the move is irreversible and must not be repeated", () => {
  const { configs } = harness();
  for (const name of ["transfer_funds", "transfer_bonus"]) {
    const description = configs[name].description ?? "";
    assert.match(description, /необратим/i, `${name} must warn that it cannot be undone`);
    assert.match(description, /повтор/i, `${name} must warn against repeating the call`);
  }
  assert.match(configs.transfer_funds.description ?? "", /РЕАЛЬНЫЕ ДЕНЬГИ/);
});

test("the list tools call their client method with no arguments", async () => {
  const { calls, tools } = harness();
  await tools.list_child_accounts({});
  await tools.list_child_accounts_with_balances({});
  assert.deepEqual(calls, [
    { method: "listChildAccounts", params: undefined },
    { method: "listChildAccountsWithBalances", params: undefined },
  ]);
});

test("a result carries the response envelope, point balance included, as compact JSON", async () => {
  const { tools } = harness();
  const res = await tools.list_child_accounts({});
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, '{"data":{"called":"listChildAccounts"},"apiPointBalance":4832}');
});

test("create_child_account forwards both fields to createNonpayerChildAccount", async () => {
  const { calls, tools } = harness();
  await tools.create_child_account({ shortName: "ООО Ромашка", isSelfAdvertisingEnabled: true });
  assert.equal(calls[0].method, "createNonpayerChildAccount");
  assert.deepEqual(calls[0].params, { shortName: "ООО Ромашка", isSelfAdvertisingEnabled: true });
});

test("transfer_funds and transfer_bonus hit different client methods with the same payload", async () => {
  const { calls, tools } = harness();
  await tools.transfer_funds({ accountIdTo: 987654321, amount: 5000 });
  await tools.transfer_bonus({ accountIdTo: 987654321, amount: 250 });
  assert.deepEqual(calls, [
    { method: "transferFunds", params: { accountIdTo: 987654321, amount: 5000 } },
    { method: "transferBonus", params: { accountIdTo: 987654321, amount: 250 } },
  ]);
});

test("the transfer schemas enforce the API's amount >= 1 and a positive destination id", () => {
  const { configs } = harness();
  for (const name of ["transfer_funds", "transfer_bonus"]) {
    const schema = schemaOf(configs[name]);
    assert.equal(schema.safeParse({ accountIdTo: 42, amount: 1 }).success, true, name);
    assert.equal(schema.safeParse({ accountIdTo: 42, amount: 0 }).success, false, `${name}: 0`);
    assert.equal(schema.safeParse({ accountIdTo: 42, amount: 0.5 }).success, false, `${name}: 0.5`);
    assert.equal(schema.safeParse({ accountIdTo: 42, amount: -100 }).success, false, `${name}: -100`);
    assert.equal(schema.safeParse({ accountIdTo: 0, amount: 10 }).success, false, `${name}: id 0`);
    assert.equal(schema.safeParse({ accountIdTo: -1, amount: 10 }).success, false, `${name}: id -1`);
    assert.equal(schema.safeParse({ accountIdTo: 1.5, amount: 10 }).success, false, `${name}: id 1.5`);
    assert.equal(schema.safeParse({ amount: 10 }).success, false, `${name}: missing id`);
    assert.equal(schema.safeParse({ accountIdTo: 42 }).success, false, `${name}: missing amount`);
  }
});

test("create_child_account requires a non-empty name and an explicit self-advertising flag", () => {
  const { configs } = harness();
  const schema = schemaOf(configs.create_child_account);
  assert.equal(schema.safeParse({ shortName: "Sub", isSelfAdvertisingEnabled: false }).success, true);
  assert.equal(schema.safeParse({ shortName: "", isSelfAdvertisingEnabled: false }).success, false);
  assert.equal(schema.safeParse({ isSelfAdvertisingEnabled: false }).success, false);
  assert.equal(schema.safeParse({ shortName: "Sub" }).success, false);
  assert.equal(schema.safeParse({ shortName: "Sub", isSelfAdvertisingEnabled: "yes" }).success, false);
});

test("a client error comes back as an isError result, not a throw", async () => {
  const { tools } = harness({ throwOn: "transferFunds" });
  const res = await tools.transfer_funds({ accountIdTo: 42, amount: 10 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
});
