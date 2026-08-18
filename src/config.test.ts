import { test } from "node:test";
import assert from "node:assert/strict";

import { ConfigError, hasCredentials, loadConfig } from "./config.js";

/**
 * The reason codes below (`invalid_*`) are the vocabulary the dashboard groups
 * by — renaming one silently splits a bar in two, so they are pinned here.
 */
const FULL = {
  AVITO_ADS_CLIENT_ID: "cid",
  AVITO_ADS_CLIENT_SECRET: "secret",
  AVITO_ADS_ACCOUNT_ID: "12345",
};

function errorOf(env: Record<string, string | undefined>): ConfigError {
  let caught: unknown;
  try {
    loadConfig(env as NodeJS.ProcessEnv);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ConfigError, "config problems must throw ConfigError, not exit");
  return caught;
}

function reasonOf(env: Record<string, string | undefined>): string {
  return errorOf(env).reason;
}

/**
 * Missing credentials used to throw here, which killed the process before the
 * MCP handshake and left the user with a dead server and no reason. It is now
 * a survivable state: the server starts degraded and the client raises
 * CredentialsError at call time instead (pinned in client.test.ts). Reverting
 * this would restore that dead end.
 */
test("a missing credential does not throw — the field stays undefined", () => {
  assert.equal(loadConfig({ ...FULL, AVITO_ADS_CLIENT_ID: undefined } as NodeJS.ProcessEnv).clientId, undefined);
  assert.equal(
    loadConfig({ ...FULL, AVITO_ADS_CLIENT_SECRET: undefined } as NodeJS.ProcessEnv).clientSecret,
    undefined,
  );
  assert.equal(loadConfig({ ...FULL, AVITO_ADS_ACCOUNT_ID: undefined } as NodeJS.ProcessEnv).accountId, undefined);
});

test("an empty or blank value is treated as absent, not as an empty credential", () => {
  const config = loadConfig({
    AVITO_ADS_CLIENT_ID: "",
    AVITO_ADS_CLIENT_SECRET: "",
    AVITO_ADS_ACCOUNT_ID: "   ",
  } as NodeJS.ProcessEnv);
  assert.equal(config.clientId, undefined);
  assert.equal(config.clientSecret, undefined);
  assert.equal(config.accountId, undefined);
  assert.equal(hasCredentials(config), false);
});

test("with no variables at all the config loads with production defaults intact", () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(hasCredentials(config), false);
  assert.equal(config.environment, "production");
  assert.equal(config.apiBase, "https://api.avito.ru/ads/");
});

test("the account id must be a positive integer", () => {
  // parseInt would happily read "12abc" as 12 and address the wrong account;
  // the 20-digit value pins the safe-integer branch (silent float rounding
  // would address the wrong account too).
  for (const bad of ["abc", "12abc", "-5", "1.5", "0", "1e5", " 12 3", "99999999999999999999"]) {
    assert.equal(reasonOf({ ...FULL, AVITO_ADS_ACCOUNT_ID: bad }), "invalid_account_id", bad);
  }
  assert.equal(loadConfig({ ...FULL, AVITO_ADS_ACCOUNT_ID: " 42 " } as NodeJS.ProcessEnv).accountId, 42);
});

test("an unknown environment is rejected rather than silently treated as production", () => {
  assert.equal(reasonOf({ ...FULL, AVITO_ADS_ENVIRONMENT: "staging" }), "invalid_environment");
});

test("a rejected value is never echoed into the message index.ts prints to stderr", () => {
  // The likeliest way to land here is a client secret pasted into the wrong
  // variable, and MCP hosts capture server stderr to disk.
  // Lowercase, so the environment branch (which lowercases its input) would
  // still leak it verbatim if the message interpolated the value.
  const secret = "secr3t-pasted-in-the-wrong-slot";
  for (const key of ["AVITO_ADS_ACCOUNT_ID", "AVITO_ADS_ENVIRONMENT"]) {
    const message = errorOf({ ...FULL, [key]: secret }).message;
    assert.equal(message.includes(secret), false, `${key} must not echo its value`);
    assert.match(message, new RegExp(key), `${key} must still name the variable`);
  }
});

test("a fully configured server loads with production defaults", () => {
  const config = loadConfig(FULL as NodeJS.ProcessEnv);
  assert.equal(hasCredentials(config), true);
  assert.equal(config.clientId, "cid");
  assert.equal(config.clientSecret, "secret");
  assert.equal(config.accountId, 12345);
  assert.equal(config.environment, "production");
  assert.equal(config.apiBase, "https://api.avito.ru/ads/");
  assert.equal(config.timeoutMs, 30_000);
  assert.equal(config.maxRetries, 4);
  assert.equal(config.tokenLeewaySeconds, 60);
});

test("the sandbox environment switches the path prefix", () => {
  const config = loadConfig({ ...FULL, AVITO_ADS_ENVIRONMENT: "SandBox" } as NodeJS.ProcessEnv);
  assert.equal(config.environment, "sandbox");
  assert.equal(config.apiBase, "https://api.avito.ru/ads-sandbox/");
});

test("AVITO_ADS_API_BASE overrides the whole base url", () => {
  const config = loadConfig({ ...FULL, AVITO_ADS_API_BASE: "http://localhost:9000/ads/" } as NodeJS.ProcessEnv);
  assert.equal(config.apiBase, "http://localhost:9000/ads/");
});

test("numeric overrides are honored; zero disables retries and leeway", () => {
  const config = loadConfig({
    ...FULL,
    AVITO_ADS_TIMEOUT_MS: "5000",
    AVITO_ADS_MAX_RETRIES: "0",
    AVITO_ADS_TOKEN_LEEWAY_SECONDS: "0",
  } as NodeJS.ProcessEnv);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.maxRetries, 0);
  assert.equal(config.tokenLeewaySeconds, 0);
});

test("garbage numeric overrides fall back to the defaults instead of NaN", () => {
  const config = loadConfig({
    ...FULL,
    AVITO_ADS_TIMEOUT_MS: "soon",
    AVITO_ADS_MAX_RETRIES: "-2",
    AVITO_ADS_TOKEN_LEEWAY_SECONDS: "",
  } as NodeJS.ProcessEnv);
  assert.equal(config.timeoutMs, 30_000);
  assert.equal(config.maxRetries, 4);
  assert.equal(config.tokenLeewaySeconds, 60);
});

test("loadConfig defaults to process.env", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, FULL);
    assert.equal(loadConfig().accountId, 12345);
  } finally {
    for (const key of Object.keys(FULL)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
