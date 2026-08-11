# Development

## Requirements

- Node.js 20+ (the published package ships compiled `dist/`; `npx` needs no separate install).

## Commands

```bash
npm install
npm run dev        # run from source with tsx watch
npm test           # test:src (unit tests) + test:dist (build, then probe dist/index.js)
npm run typecheck  # type-check src + tests (no emit)
npm run build      # clean dist/ and compile with tsc
npm run smoke      # live READ-ONLY calls: account, balance, one page of campaigns
```

`npm test` runs two suites: `test:src` executes every `src/**/*.test.ts` through `tsx`, and
`test:dist` rebuilds `dist/` and runs `test/dist-smoke.test.js`, which spawns the **built** server
over stdio and asserts the tool inventory and annotations that the README and `docs/TOOLS.md`
describe. Both are offline.

## Local run

```bash
npm run build
AVITO_ADS_CLIENT_ID=... AVITO_ADS_CLIENT_SECRET=... AVITO_ADS_ACCOUNT_ID=... node dist/index.js
# optional: AVITO_ADS_ENVIRONMENT, AVITO_ADS_TIMEOUT_MS, AVITO_ADS_MAX_RETRIES,
#           AVITO_ADS_TOKEN_LEEWAY_SECONDS, AVITO_ADS_API_BASE
```

`npm run smoke` needs the same credentials and makes three reads — account details, balance and
one short page of campaigns — and no writes. It prints the remaining `Api-Point-Balance` after
every step: **the smoke check spends weekly points too.** Prefer running it with
`AVITO_ADS_ENVIRONMENT=sandbox`, or point `AVITO_ADS_API_BASE` at a mock.

## Tests

Unit tests mock `globalThis.fetch` (client, token flow, retries, SSRF guard) or drive the tools
against a fake client, so the whole suite runs offline. Put a `*.test.ts` next to the code it
covers; `npm run typecheck && npm test` is the gate (also run by `prepublishOnly`).

Never point the suite — or an ad-hoc script — at the real API: every call spends from the weekly
point budget, which only refills on Mondays at 00:00 UTC.

## The point budget while developing

The Avito Ads API meters by **weekly points**, not by request rate. When exercising the server by
hand, use `AVITO_ADS_API_BASE` with a local mock server (the client derives the token endpoint
from the base, so a mock that serves `POST /token` plus the API paths is self-consistent), or the
sandbox environment. Client-side validation — date format and the 100-day statistics cap, amount
minimums, contract per-type rules, page bounds, the SSRF guard — all rejects before the request,
so those failure modes cost nothing.

## Usage telemetry

The server sends anonymous events to `usage.gistrec.cloud` (`server_start` when a client connects,
`tool_call` with the tool **name**, and `startup_failed` with a machine-readable reason code when
credentials are missing) so we can count active installs and see which tools matter. An event
carries only impersonal technical fields: a random install id
(`~/.config/mcp-avito-ads/instance-id`), the package version, the AI application's name and
version from the MCP handshake, the Node.js version and the OS.

Credentials, account data, tool arguments and request contents are never sent (implementation:
`src/telemetry.ts`). Delivery is fire-and-forget with a 2 s timeout and is silently skipped on any
error. Opt out of telemetry for every Ask Ads MCP server at once: `ASKADS_TELEMETRY=0`.
