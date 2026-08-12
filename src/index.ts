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

/**
 * Prose handed to the calling model in the `initialize` result, before it picks
 * a tool. It carries only what the tool list cannot: which Avito API this is
 * (the ads cabinet, not the seller API everyone confuses it with), where the
 * surface ends, what a call costs, and what a bare 403 actually means. It is
 * prepended to every session's context, so it stays short and states no fact
 * that is not already proven in the repo.
 */
const INSTRUCTIONS =
  "Авито Реклама — рекламный кабинет медийных и performance-кампаний, а не API продавца Авито: " +
  "для товарных объявлений, чатов и заказов нужны другие учётные данные. Рекламный аккаунт задан " +
  "в AVITO_ADS_ACCOUNT_ID, ни один инструмент его не переопределяет. Кампании, группы объявлений " +
  "и креативы доступны только на чтение — без создания, изменения, приостановки и удаления, " +
  "таргетинга нет, — а единственные изменяемые поля в дереве объявлений это бюджет и ставка " +
  "группы; рекламодатели и договоры только добавляются. Учёт вызовов — недельная квота баллов " +
  "(балл за вызов, пополняется по понедельникам в 00:00 UTC), а не лимит запросов; каждый ответ " +
  "несёт остаток apiPointBalance, и по нему стоит рассчитывать вызовы: один широкий период " +
  "статистики (максимум 100 дней) лучше нескольких узких, limit до 100 лучше страниц по 20. " +
  "Пустой 403 без сообщения — это не нехватка прав, а признак того, что AVITO_ADS_ACCOUNT_ID не " +
  "тот аккаунт, для которого выдан ключ; 401 — это учётные данные. Переводы двигают реальные " +
  "деньги, необратимы и не оставляют журнала: после неясного сбоя стоит проверить " +
  "list_child_accounts_with_balances, а не повторять перевод. AVITO_ADS_ENVIRONMENT=sandbox " +
  "переключает на тестовый API с собственными баллами.";

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
    console.error(`Ошибка: ${err.message}`);
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

  const server = new McpServer(
    {
      name: "mcp-avito-ads",
      version,
    },
    // `instructions` rides in the initialize result, so the model reads it once
    // per session before any tool call — the only prose it is guaranteed to see.
    { instructions: INSTRUCTIONS },
  );

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
  console.error(`mcp-avito-ads работает через stdio (аккаунт ${config.accountId}, ${config.environment})`);
}

main().catch((err) => {
  console.error("Критическая ошибка запуска mcp-avito-ads:", err);
  process.exit(1);
});
