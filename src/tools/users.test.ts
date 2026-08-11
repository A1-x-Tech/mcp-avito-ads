import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { ValidationError } from "../types.js";
import { registerUserTools } from "./users.js";

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

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/**
 * Fake server + fake client so the handlers run without network. The client
 * answers with the real envelope shape ({data, apiPointBalance}) so the tests
 * can check that the point balance reaches the model.
 */
function harness(opts: { throwOn?: string; data?: unknown } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const make = (method: string) => async (params?: unknown) => {
    calls.push({ method, params });
    if (opts.throwOn === method) throw new ValidationError("boom");
    return { data: opts.data ?? { ok: true }, apiPointBalance: 4200 };
  };
  const client = {
    listUsers: make("listUsers"),
    addUser: make("addUser"),
    setUserRole: make("setUserRole"),
    deleteUser: make("deleteUser"),
  };

  const tools: Record<string, Handler> = {};
  const configs: Record<string, ToolConfig> = {};
  const server = {
    registerTool: (name: string, cfg: ToolConfig, handler: Handler) => {
      configs[name] = cfg;
      tools[name] = handler;
    },
  };
  registerUserTools(server as never, client as never);
  return { calls, tools, configs };
}

/** Parses args through a tool's registered inputSchema, as the MCP server does. */
function parse(cfg: ToolConfig, args: Args) {
  return z.object(cfg.inputSchema ?? {}).safeParse(args);
}

// --- Registration ---

test("registers the four user tools", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), ["add_user", "delete_user", "list_users", "set_user_role"]);
});

test("every tool carries a title, a description and all four annotation hints", () => {
  const { configs } = harness();
  for (const [name, cfg] of Object.entries(configs)) {
    assert.ok(cfg.title, `${name} is missing a title`);
    assert.ok((cfg.description ?? "").length > 40, `${name} needs a real description`);
    const a = cfg.annotations;
    assert.ok(a, `${name} is missing annotations`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      assert.equal(typeof a?.[hint], "boolean", `${name} must set ${hint}`);
    }
  }
});

test("list_users is read-only; the write tools are not", () => {
  const { configs } = harness();
  assert.deepEqual(configs.list_users.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  for (const name of ["add_user", "set_user_role", "delete_user"]) {
    assert.equal(configs[name].annotations?.readOnlyHint, false, `${name} must not be read-only`);
  }
});

test("add_user and set_user_role are idempotent writes, not destructive", () => {
  const { configs } = harness();
  for (const name of ["add_user", "set_user_role"]) {
    assert.equal(configs[name].annotations?.destructiveHint, false, `${name} must not be destructive`);
    assert.equal(configs[name].annotations?.idempotentHint, true, `${name} sets the same role every time`);
  }
});

test("delete_user is flagged destructive and non-idempotent", () => {
  const { configs } = harness();
  assert.deepEqual(configs.delete_user.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});

// --- Arguments reaching the client ---

test("list_users takes no arguments and calls client.listUsers", async () => {
  const { calls, tools, configs } = harness();
  assert.deepEqual(Object.keys(configs.list_users.inputSchema ?? {}), []);
  await tools.list_users({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "listUsers");
});

test("add_user forwards userId and role as one object", async () => {
  const { calls, tools } = harness();
  await tools.add_user({ userId: 94235311, role: "admin" });
  assert.equal(calls[0].method, "addUser");
  assert.deepEqual(calls[0].params, { userId: 94235311, role: "admin" });
});

test("set_user_role forwards userId and role as one object", async () => {
  const { calls, tools } = harness();
  await tools.set_user_role({ userId: 42, role: "viewer" });
  assert.equal(calls[0].method, "setUserRole");
  assert.deepEqual(calls[0].params, { userId: 42, role: "viewer" });
});

test("delete_user passes the bare id, not an object", async () => {
  const { calls, tools } = harness();
  await tools.delete_user({ userId: 42 });
  assert.equal(calls[0].method, "deleteUser");
  assert.equal(calls[0].params, 42);
});

test("no tool accepts an accountId — the account comes from config", () => {
  const { configs } = harness();
  for (const [name, cfg] of Object.entries(configs)) {
    const keys = Object.keys(cfg.inputSchema ?? {});
    assert.ok(!keys.some((k) => /account/i.test(k)), `${name} must not take an account argument`);
  }
});

// --- Input validation (the schemas the MCP server enforces) ---

test("role only accepts admin and viewer", () => {
  const { configs } = harness();
  for (const name of ["add_user", "set_user_role"]) {
    assert.equal(parse(configs[name], { userId: 1, role: "admin" }).success, true);
    assert.equal(parse(configs[name], { userId: 1, role: "viewer" }).success, true);
    assert.equal(parse(configs[name], { userId: 1, role: "owner" }).success, false, `${name} accepted "owner"`);
    assert.equal(parse(configs[name], { userId: 1, role: "ADMIN" }).success, false, `${name} accepted "ADMIN"`);
    assert.equal(parse(configs[name], { userId: 1 }).success, false, `${name} accepted a missing role`);
  }
});

test("userId must be a positive integer and is required", () => {
  const { configs } = harness();
  for (const [name, args] of [
    ["add_user", { role: "admin" }],
    ["set_user_role", { role: "admin" }],
    ["delete_user", {}],
  ] as const) {
    const cfg = configs[name];
    assert.equal(parse(cfg, { ...args, userId: 42 }).success, true, `${name} rejected a valid id`);
    assert.equal(parse(cfg, { ...args }).success, false, `${name} accepted a missing userId`);
    assert.equal(parse(cfg, { ...args, userId: 0 }).success, false, `${name} accepted 0`);
    assert.equal(parse(cfg, { ...args, userId: -1 }).success, false, `${name} accepted a negative id`);
    assert.equal(parse(cfg, { ...args, userId: 1.5 }).success, false, `${name} accepted a fractional id`);
    assert.equal(parse(cfg, { ...args, userId: "42" }).success, false, `${name} accepted a string id`);
  }
});

// --- Results ---

test("the result is compact JSON carrying data and the weekly point balance", async () => {
  const { tools } = harness({ data: [{ id: 7, role: "admin", hasLoggedIn: true }] });
  const res = await tools.list_users({});
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text.includes("\n"), false, "output must not be pretty-printed");
  assert.deepEqual(JSON.parse(res.content[0].text), {
    data: [{ id: 7, role: "admin", hasLoggedIn: true }],
    apiPointBalance: 4200,
  });
});

test("a client rejection comes back as an isError result, not a throw", async () => {
  const { tools } = harness({ throwOn: "addUser" });
  const res = await tools.add_user({ userId: 1, role: "admin" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
});
