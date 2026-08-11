#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AvitoAdsClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { instrumentToolCalls, Telemetry } from "./telemetry.js";
import type { AvitoAdsConfig } from "./types.js";
import { registerAccountTools } from "./tools/account.js";
import { registerChildAccountTools } from "./tools/child-accounts.js";
import { registerOrdTools } from "./tools/ord.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerStatisticsTools } from "./tools/statistics.js";
import { registerUserTools } from "./tools/users.js";
import { registerRawTool } from "./tools/raw.js";

/** Reads the package version so the server reports its real version to MCP clients. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Loads the config, reporting the drop-off if it is missing. An unconfigured
 * server dies before the MCP handshake, so this ping is the only trace such an
 * install ever leaves — and it has to be awaited, or process.exit() below would
 * kill the request in flight.
 */
async function loadConfigOrExit(telemetry: Telemetry): Promise<AvitoAdsConfig> {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Error: ${err.message}`);
    await telemetry.sendBlocking("startup_failed", { reason: err.reason });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Anonymous usage pings (ids/names/versions only, never data or arguments);
  // opt out with ASKADS_TELEMETRY=0. Built before the config so missing
  // credentials can be reported; wired to the server before tools register.
  const version = readVersion();
  const telemetry = new Telemetry(version);
  const config = await loadConfigOrExit(telemetry);
  // The User-Agent is set here because this is the only place that knows the
  // package version; Avito sees an identified client instead of Node's "node".
  const client = new AvitoAdsClient({ ...config, userAgent: `mcp-avito-ads/${version}` });

  const server = new McpServer({
    name: "mcp-avito-ads",
    version,
  });

  instrumentToolCalls(server, telemetry);
  server.server.oninitialized = () => {
    telemetry.setClientInfo(server.server.getClientVersion());
    telemetry.send("server_start");
  };

  registerAccountTools(server, client);
  registerChildAccountTools(server, client);
  registerOrdTools(server, client);
  registerCatalogTools(server, client);
  registerStatisticsTools(server, client);
  registerUserTools(server, client);
  registerRawTool(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`mcp-avito-ads running on stdio (account ${config.accountId}, ${config.environment})`);
}

main().catch((err) => {
  console.error("Fatal error starting mcp-avito-ads:", err);
  process.exit(1);
});
