/**
 * Built-artifact smoke test: everything here runs against `dist/`, not `src/`.
 *
 * It spawns the published entrypoint exactly as an MCP host would — `node
 * dist/index.js` over stdio, with credentials in the environment — completes
 * the handshake and lists the tools. That catches the failures a source test
 * structurally cannot: a missing `#!/usr/bin/env node`, a register* call left
 * out of index.ts, an import that only resolves under tsx, a tool whose zod
 * shape throws during JSON-schema conversion, or annotations dropped by the
 * build. No network call is made: the client mints its OAuth2 token lazily on
 * the first API call, and listing tools makes none.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRYPOINT = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Every tool the assembled server must expose, with the annotations it ships. */
const EXPECTED = {
  // account.ts
  get_account: "READ_ONLY",
  get_balance: "READ_ONLY",
  create_sandbox_account: "CREATE",
  // child-accounts.ts
  list_child_accounts: "READ_ONLY",
  list_child_accounts_with_balances: "READ_ONLY",
  create_child_account: "CREATE",
  transfer_funds: "DESTRUCTIVE",
  transfer_bonus: "DESTRUCTIVE",
  // ord.ts
  create_advertiser: "CREATE",
  list_advertisers: "READ_ONLY",
  create_contract: "CREATE",
  list_contracts: "READ_ONLY",
  // catalog.ts
  list_campaigns: "READ_ONLY",
  list_groups: "READ_ONLY",
  list_creatives: "READ_ONLY",
  change_group_budget: "WRITE",
  change_group_price: "WRITE",
  // statistics.ts
  campaign_stats: "READ_ONLY",
  group_stats: "READ_ONLY",
  creative_stats: "READ_ONLY",
  // users.ts
  list_users: "READ_ONLY",
  add_user: "WRITE",
  set_user_role: "WRITE",
  delete_user: "DESTRUCTIVE",
  // raw.ts
  raw_request: "DESTRUCTIVE",
};

/** The four hints behind each label above — mirrors src/tools/util.ts. */
const ANNOTATIONS = {
  READ_ONLY: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  WRITE: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  CREATE: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  DESTRUCTIVE: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/**
 * Handshakes with a freshly spawned dist server and returns its tool list.
 * The credentials are syntactically valid but fake — startup must not touch the
 * network, and if it ever did, these would fail instead of hitting a real account.
 */
async function listToolsFromDist() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRYPOINT],
    env: {
      PATH: process.env.PATH ?? "",
      AVITO_ADS_CLIENT_ID: "test-client-id",
      AVITO_ADS_CLIENT_SECRET: "test-client-secret",
      AVITO_ADS_ACCOUNT_ID: "12345",
      AVITO_ADS_ENVIRONMENT: "sandbox",
      // Never ping the telemetry endpoint from a test run.
      ASKADS_TELEMETRY: "0",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "dist-smoke", version: "0" });
  await client.connect(transport);
  try {
    return { tools: (await client.listTools()).tools, serverVersion: client.getServerVersion() };
  } finally {
    await client.close();
  }
}

test("dist server handshakes over stdio and exposes the full tool set", async () => {
  const { tools, serverVersion } = await listToolsFromDist();

  assert.equal(serverVersion?.name, "mcp-avito-ads");
  assert.match(serverVersion?.version ?? "", /^\d+\.\d+\.\d+/);

  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, Object.keys(EXPECTED).sort());
});

test("dist tools keep their annotations, descriptions and input schemas", async () => {
  const { tools } = await listToolsFromDist();

  for (const tool of tools) {
    const label = EXPECTED[tool.name];
    assert.ok(label, `unexpected tool ${tool.name}`);
    assert.deepEqual(
      {
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
        idempotentHint: tool.annotations?.idempotentHint,
        openWorldHint: tool.annotations?.openWorldHint,
      },
      ANNOTATIONS[label],
      `${tool.name} should ship the ${label} annotations`,
    );

    // A tool the model cannot understand is as good as missing.
    assert.ok((tool.description ?? "").length > 40, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} needs an object input schema`);
    // $ref survives zod-to-json-schema dedup and some consumers do not resolve
    // it, rendering the field as `any`; util.ts's factories exist to avoid it.
    assert.equal(
      JSON.stringify(tool.inputSchema).includes('"$ref"'),
      false,
      `${tool.name} input schema must not contain $ref`,
    );
  }
});

test("dist server refuses to start without credentials", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [ENTRYPOINT], {
    env: { PATH: process.env.PATH ?? "", ASKADS_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 1);
  assert.match(stderr, /AVITO_ADS_CLIENT_ID is required/);
});
