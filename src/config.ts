import type { AvitoAdsConfig, Environment } from "./types.js";

/** Avito API host; the token endpoint and both environments live under it. */
const DEFAULT_HOST = "https://api.avito.ru";
/** Path prefix per environment (the only difference between prod and sandbox). */
const PREFIX: Record<Environment, string> = { production: "ads", sandbox: "ads-sandbox" };

/**
 * The production API base — the default of a fully configured server, and what
 * index.ts falls back to when a malformed config degrades to "no credentials".
 */
export const DEFAULT_API_BASE = `${DEFAULT_HOST}/${PREFIX.production}/`;

/**
 * A malformed environment variable. Thrown instead of exiting on the spot so
 * index.ts can catch it, report the drop-off and start degraded instead of
 * dying; `reason` is the machine-readable code that ships with that ping
 * (never a variable's value). A *missing* credential is NOT a ConfigError —
 * see loadConfig.
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

/** True when every credential the API needs is present (id, secret and account). */
export function hasCredentials(config: AvitoAdsConfig): boolean {
  return Boolean(config.clientId && config.clientSecret && config.accountId !== undefined);
}

/**
 * Builds the client config from environment variables. The variable names match
 * the official Avito SDK so a working set of credentials is portable between
 * the two.
 *
 * Missing credentials are NOT an error here: the fields stay `undefined`, the
 * server starts anyway and the client raises CredentialsError per tool call
 * (see client.ts), so an unconfigured install completes the MCP handshake and
 * the model can tell the user which variable to set — instead of dying before
 * `initialize` and leaving a dead server with no reason. There is no in-chat
 * login: the fix is the operator setting the variables and restarting the
 * server. A *malformed* value (a non-numeric account id, an unknown
 * environment) still throws ConfigError, because guessing what the user meant
 * is worse — index.ts catches it and degrades instead of exiting.
 *
 *   AVITO_ADS_CLIENT_ID              OAuth2 client id
 *   AVITO_ADS_CLIENT_SECRET          OAuth2 client secret
 *   AVITO_ADS_ACCOUNT_ID             ad account id, positive integer
 *   AVITO_ADS_ENVIRONMENT            production (default) | sandbox
 *   AVITO_ADS_TIMEOUT_MS             per-request timeout (default 30000)
 *   AVITO_ADS_MAX_RETRIES            retries for 429/5xx/network (default 4)
 *   AVITO_ADS_TOKEN_LEEWAY_SECONDS   refresh the token this early (default 60)
 *   AVITO_ADS_API_BASE               API root override, e.g. a local mock
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AvitoAdsConfig {
  // An empty string reads as absent, never as an empty credential.
  const clientId = env.AVITO_ADS_CLIENT_ID || undefined;
  const clientSecret = env.AVITO_ADS_CLIENT_SECRET || undefined;

  const accountRaw = (env.AVITO_ADS_ACCOUNT_ID ?? "").trim();
  let accountId: number | undefined;
  if (accountRaw) {
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
    accountId = Number(accountRaw);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) die(badAccountId, "invalid_account_id");
  }

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
