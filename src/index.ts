#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AvitoAdsClient } from "./client.js";
import { ConfigError, DEFAULT_API_BASE, hasCredentials, loadConfig } from "./config.js";
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

/**
 * Prepended to INSTRUCTIONS when a credential is missing. The model reads this
 * before it picks a tool, so an unconfigured session opens with the fix rather
 * than with a failed call. There is no in-chat login: credentials come only
 * from the environment, so the fix is the operator's — set the variables and
 * restart the server.
 */
const UNCONFIGURED_PREFIX =
  "ВНИМАНИЕ: Авито Реклама ещё не подключена — не заданы переменные окружения AVITO_ADS_CLIENT_ID, " +
  "AVITO_ADS_CLIENT_SECRET и/или AVITO_ADS_ACCOUNT_ID, поэтому любой вызов инструмента вернёт " +
  "ошибку. Подключиться из диалога нельзя: оператор должен взять Client Key и Client Secret " +
  "приложения API в кабинете Авито Рекламы (пара OAuth2 client_credentials; приложение создаёт " +
  "владелец аккаунта или администратор), записать id рекламного аккаунта, которому принадлежат " +
  "эти доступы, задать их в AVITO_ADS_CLIENT_ID, AVITO_ADS_CLIENT_SECRET и AVITO_ADS_ACCOUNT_ID " +
  "в конфигурации MCP-клиента и перезапустить сервер — переменные читаются только при старте. ";

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
 * Loads the config without dying on a bad value. A server that exits here never
 * completes the MCP handshake, so the user sees a dead server and no reason —
 * instead the problem is carried into the session, where the model can read it
 * and relay it. (Missing credentials are not an error at all — loadConfig
 * leaves the fields undefined; a *malformed* value still throws ConfigError,
 * caught here: the config degrades to "no credentials" over the production
 * base, and every tool call answers with CredentialsError.)
 */
function loadConfigOrDegraded(telemetry: Telemetry): {
  config: AvitoAdsConfig;
  problem?: ConfigError;
} {
  try {
    return { config: loadConfig() };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Ошибка конфигурации: ${err.message}`);
    // Fire-and-forget now that the process survives: the historical
    // `startup_failed` funnel stays comparable, but nothing blocks startup.
    telemetry.send("startup_failed", { reason: err.reason });
    return {
      // The default production base on purpose: with the environment possibly
      // being the malformed value, production is the only base left to trust —
      // and no request reaches it anyway, credentials are gone.
      config: {
        environment: "production",
        apiBase: process.env.AVITO_ADS_API_BASE || DEFAULT_API_BASE,
      },
      problem: err,
    };
  }
}

async function main(): Promise<void> {
  // Anonymous usage pings (ids/names/versions only, never data or arguments);
  // opt out with ASKADS_TELEMETRY=0. Built before the config so missing
  // credentials can be reported; wired to the server before tools register.
  const version = readVersion();
  const telemetry = new Telemetry(version);
  const { config, problem } = loadConfigOrDegraded(telemetry);
  // The User-Agent is set here because this is the only place that knows the
  // package version; Avito sees an identified client instead of Node's "node".
  const client = new AvitoAdsClient({ ...config, userAgent: `mcp-avito-ads/${version}` });

  // Credentials come only from the environment, so this cannot change
  // mid-session: an unconfigured start stays unconfigured until the operator
  // sets the variables and restarts the server.
  const connected = hasCredentials(config);

  const server = new McpServer(
    {
      name: "mcp-avito-ads",
      version,
    },
    // `instructions` rides in the initialize result, so the model reads it once
    // per session before any tool call — the only prose it is guaranteed to see.
    // An unconfigured session opens with the fix (and the config problem, when
    // a malformed value is what got us here) before the briefing.
    {
      instructions: connected
        ? INSTRUCTIONS
        : UNCONFIGURED_PREFIX + (problem ? `Проблема конфигурации: ${problem.message} ` : "") + INSTRUCTIONS,
    },
  );

  instrumentToolCalls(server, telemetry);
  server.server.oninitialized = () => {
    telemetry.setClientInfo(server.server.getClientVersion());
    // Split on purpose: `server_start` keeps meaning "a usable install started",
    // so the unconfigured case gets its own event instead of inflating that
    // number. The reason vocabulary is the historical closed set — with several
    // variables absent the first one wins, matching the old check order.
    if (connected) telemetry.send("server_start");
    else {
      telemetry.send("unconfigured_start", {
        reason:
          problem?.reason ??
          (!config.clientId
            ? "missing_client_id"
            : !config.clientSecret
              ? "missing_client_secret"
              : "missing_account_id"),
      });
    }
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
  console.error(
    connected
      ? `mcp-avito-ads работает через stdio (аккаунт ${config.accountId}, ${config.environment})`
      : "mcp-avito-ads работает через stdio (креденшелы не заданы — задайте AVITO_ADS_CLIENT_ID, " +
          "AVITO_ADS_CLIENT_SECRET и AVITO_ADS_ACCOUNT_ID и перезапустите сервер)",
  );
}

main().catch((err) => {
  console.error("Критическая ошибка запуска mcp-avito-ads:", err);
  process.exit(1);
});
