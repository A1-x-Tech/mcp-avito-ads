import type { AvitoAdsConfig, Environment } from "./types.js";

/** Avito API host; the token endpoint and both environments live under it. */
const DEFAULT_HOST = "https://api.avito.ru";
/** Path prefix per environment (the only difference between prod and sandbox). */
const PREFIX: Record<Environment, string> = { production: "ads", sandbox: "ads-sandbox" };

/**
 * A missing or malformed environment variable. Thrown instead of exiting on the
 * spot so index.ts can report the drop-off before the process dies; `reason` is
 * the machine-readable code that ships with that ping (never a variable's value).
 */
export class ConfigError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

function die(message: string, reason: string): never {
  throw new ConfigError(message, reason);
}

/** Reads a numeric env var that must be > 0, else returns the fallback. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Same, but 0 is a meaningful value (no retries / no refresh leeway). */
function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Builds the client config from environment variables, throwing ConfigError if
 * a required one is missing or malformed. The variable names match the official
 * Avito SDK so a working set of credentials is portable between the two.
 *
 *   AVITO_ADS_CLIENT_ID              OAuth2 client id (required)
 *   AVITO_ADS_CLIENT_SECRET          OAuth2 client secret (required)
 *   AVITO_ADS_ACCOUNT_ID             ad account id, positive integer (required)
 *   AVITO_ADS_ENVIRONMENT            production (default) | sandbox
 *   AVITO_ADS_TIMEOUT_MS             per-request timeout (default 30000)
 *   AVITO_ADS_MAX_RETRIES            retries for 429/5xx/network (default 4)
 *   AVITO_ADS_TOKEN_LEEWAY_SECONDS   refresh the token this early (default 60)
 *   AVITO_ADS_API_BASE               API root override, e.g. a local mock
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AvitoAdsConfig {
  const clientId = env.AVITO_ADS_CLIENT_ID;
  if (!clientId) {
    die("Требуется AVITO_ADS_CLIENT_ID — client id приложения Авито (OAuth2).", "missing_client_id");
  }
  const clientSecret = env.AVITO_ADS_CLIENT_SECRET;
  if (!clientSecret) {
    die(
      "Требуется AVITO_ADS_CLIENT_SECRET — client secret приложения Авито (OAuth2).",
      "missing_client_secret",
    );
  }

  const accountRaw = (env.AVITO_ADS_ACCOUNT_ID ?? "").trim();
  if (!accountRaw) {
    die("Требуется AVITO_ADS_ACCOUNT_ID — рекламный аккаунт, которому принадлежат учётные данные.", "missing_account_id");
  }
  // Strict digits: Number("12abc") is NaN but parseInt("12abc") is 12, and a
  // silently truncated account id would address someone else's account.
  //
  // The rejected value is never echoed back: index.ts prints this message to
  // stderr, which MCP hosts capture to disk, and the likeliest way to land here
  // is a client secret pasted into the wrong variable. Describing the shape is
  // just as actionable as quoting the value.
  const badAccountId =
    "AVITO_ADS_ACCOUNT_ID должен быть положительным целым числом (только цифры, без пробелов, букв и знаков).";
  if (!/^\d+$/.test(accountRaw)) die(badAccountId, "invalid_account_id");
  const accountId = Number(accountRaw);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) die(badAccountId, "invalid_account_id");

  const envName = (env.AVITO_ADS_ENVIRONMENT ?? "").trim().toLowerCase();
  if (envName && envName !== "production" && envName !== "sandbox") {
    // Same rule: the accepted vocabulary, not the rejected value.
    die('AVITO_ADS_ENVIRONMENT должен быть "production" или "sandbox".', "invalid_environment");
  }
  const environment: Environment = envName === "sandbox" ? "sandbox" : "production";

  // The override replaces the whole base, prefix included, so a mock server can
  // be pointed at directly; otherwise the environment picks the prefix.
  const apiBase = env.AVITO_ADS_API_BASE || `${DEFAULT_HOST}/${PREFIX[environment]}/`;

  return {
    clientId,
    clientSecret,
    accountId,
    environment,
    apiBase,
    timeoutMs: positiveNumber(env.AVITO_ADS_TIMEOUT_MS, 30_000),
    maxRetries: nonNegativeNumber(env.AVITO_ADS_MAX_RETRIES, 4),
    tokenLeewaySeconds: nonNegativeNumber(env.AVITO_ADS_TOKEN_LEEWAY_SECONDS, 60),
  };
}
