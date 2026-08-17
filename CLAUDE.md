# CLAUDE.md — mcp-avito-ads

MCP server for the **Avito Ads API** (Avito Reklama — the media / performance advertising
cabinet, *not* the Avito seller/listings API), TypeScript over stdio. Base
`https://api.avito.ru/ads/` (`/ads-sandbox/` in the sandbox); auth is OAuth2
`client_credentials` against `https://api.avito.ru/token` exchanged for a Bearer token; every path
is account-scoped `v1/account/{accountID}/...` with the id from `AVITO_ADS_ACCOUNT_ID`. The API is
metered by a **weekly point budget** (refilled Mondays 00:00 UTC) reported in the
`Api-Point-Balance` header of every response.

The wire protocol was derived from the official SDK
(github.com/avito-tech/avito-ads-sdk-typescript, MIT) — the public HTTP docs are unreachable. The
SDK is **not** a dependency: we own our transport so `raw_request` can exist.

## Commands

```bash
npm run dev        # run from source (tsx watch)
npm test           # unit tests + a dist smoke probe, no network
npm run typecheck  # types for src + tests
npm run build      # emit dist/
npm run smoke      # live READ-ONLY calls (needs the three required env vars; spends points)
```

## Architecture

- `src/config.ts` — env → config; throws `ConfigError` (with a `reason` code) instead of exiting,
  so `index.ts` can report the drop-off before dying. Requires `AVITO_ADS_CLIENT_ID`,
  `AVITO_ADS_CLIENT_SECRET`, `AVITO_ADS_ACCOUNT_ID` (digits only — a truncated id would address
  someone else's account); optional `AVITO_ADS_ENVIRONMENT`, `AVITO_ADS_TIMEOUT_MS`,
  `AVITO_ADS_MAX_RETRIES`, `AVITO_ADS_TOKEN_LEEWAY_SECONDS`, `AVITO_ADS_API_BASE`.
- `src/types.ts` — config, wire types, the enum tuples (`CAMPAIGN_STATUSES`, `CONTRACT_TYPES`, …)
  the tools build zod enums from, `ApiResponse<T> = {data, apiPointBalance}`, `AvitoAdsError`,
  `ValidationError`. Field names mirror the API's inconsistent casing (`accountID` here,
  `accountId` there) — do not "fix" them.
- `src/client.ts` — one token cached in memory (concurrent callers share one in-flight request,
  refreshed `tokenLeewaySeconds` early, dropped and re-minted once on a 401). `request()` resolves
  the path against the base and rejects anything that escapes it (SSRF guard), enforces an
  AbortController timeout that also covers reading the body, retries with backoff, and lifts
  `Api-Point-Balance` into the envelope. Also holds the pre-flight validators:
  `validateContractInput`, `assertPeriod` (100-day cap), `assertAmount`, `normalizeListRequest`.
- `src/tools/*.ts` — `account`, `child-accounts`, `ord`, `catalog`, `statistics`, `users`, `raw`;
  each exports one `register*Tools(server, client)`. `tools/util.ts` — `ok`/`fail`, the annotation
  presets and the shared zod schema **factories**.
- `src/index.ts` — wires every `register*` into the McpServer.
- `src/telemetry.ts` — anonymous usage pings (ids/names/versions only, never data or arguments;
  fire-and-forget, must never block or throw; opt-out `ASKADS_TELEMETRY=0`). `startup_failed` is
  the exception: `sendBlocking` awaits it, because the caller exits right after. Its `reason` is a
  closed vocabulary (`missing_client_id`, …) — never a variable's name or value.

## Conventions (do not break)

- **The account id is config, never an argument.** No tool takes one; the client injects it into
  every path. `transfer_funds` / `transfer_bonus` take only the destination, and `client.resolve`
  refuses a `raw_request` path that names another account (checked on the *resolved* path, so `..`
  cannot dodge it).
- **Retries are asymmetric.** 429 always repeats (the call was refused, not performed); 5xx and
  network errors repeat for reads only — a repeated funds transfer moves the money twice.
- **Validate before spending a point.** Anything checkable offline (dates, the 100-day cap,
  amounts ≥ 1, contract per-type rules, page bounds, path origin and account id,
  `create_sandbox_account` outside the sandbox) is rejected client-side.
- **Surface `apiPointBalance`.** Client methods return `{data, apiPointBalance}` and tools pass
  that envelope straight to `ok`, so the agent always sees the weekly quota left. Say so in tool
  descriptions. Failures carry it too: `AvitoAdsError` holds the balance and `Retry-After`, and
  `fail()` appends both.
- **The API surface is narrow — say so in the descriptions.** Campaigns, groups and creatives
  cannot be created, edited, paused or deleted; targeting is not exposed; advertisers and
  contracts are append-only. Descriptions state what a tool *cannot* do so the model does not go
  hunting for tools that do not exist.
- **Annotations:** `READ_ONLY` for reads, `WRITE` for idempotent overwrites (budget, bid, role),
  `CREATE` for non-idempotent creates (sandbox account, child account, advertiser, contract),
  `DESTRUCTIVE` for transfers, `delete_user` and `raw_request`. All four hints are always set.
- **Validate inputs with zod** in `inputSchema`, reusing the schema **factories** in `util.ts` (a
  fresh schema per field avoids `$ref` dedup in the generated JSON schema). zod stays on **v3**
  (`^3.25.0`).
- **Output compact JSON via `ok`** — the consumer is an LLM; pretty-printing burns tokens.
- **Wire renaming lives at the edge that knows it:** the catalog filter id lists
  (`campaignIds` → `campaignIDs`, …) in `catalog.ts`, `counterpartyType` → `description` in
  `ord.ts`; everything else passes through as the API spells it.

## Adding a tool

Before changing the tool registry, read [the MCP capability documentation contract](docs/CAPABILITY-DOCUMENTATION.md). Every registered tool must have exactly one task-oriented page in `docs/capabilities/`; update that page, the index, and the coverage test in the same change.

1. Add (or extend) `src/tools/<name>.ts` with `register<Name>Tools(server, client)`.
2. If it hits a new endpoint, add a method to `src/client.ts` (path, body, retry-safety flag).
3. Import and call the register fn in `src/index.ts`.
4. Add a `*.test.ts` using the mock-fetch (client) / fake-client (tools) harness — no network.
5. Update `docs/TOOLS.md` and the inventory in `test/dist-smoke.test.js`.
6. `npm run typecheck && npm test`.

## Known gaps

- Whether the API reads an empty `groupIDs` / `creativeIDs` as "every entity" is undocumented, so
  `group_stats` / `creative_stats` require the id list (as the SDK does) rather than guessing;
  `campaign_stats` is the way to cover a whole campaign.
- `list*` tools reject out-of-range `limit`/`page` in zod, so `normalizeListRequest`'s clamp is
  unreachable from MCP. Rejecting matches the official SDK and costs no point; keep it.
- Statistics tools are the only ones never exercised against the live API: neither the production
  account nor the sandbox had a single campaign to report on (see below).

## What the live API taught us (2026-08-11)

Verified against a real cabinet; none of this is in the SDK or the public docs.

- **A bare `403` means the account id, not the rights.** The token is minted for exactly one
  account, so a mismatched `AVITO_ADS_ACCOUNT_ID` fails with `403 Forbidden` and an empty body —
  indistinguishable from a permissions problem until you know. `401` is the credentials.
  `fail()` and the smoke check say so explicitly; keep that hint, it costs four blind probes to
  rediscover. A `403` that carries its own message is specific and must not be overwritten.
- **Path shape is confirmed.** A route that does not exist answers `404 no Route matched with
  those values`; a foreign account answers `403`. So a 403 also proves the path is right.
- **The sandbox is not a mirror.** `balance` answers `404` there. `create_sandbox_account` outside
  the sandbox answers `403 Ручка доступна только для песочницы`.
- **You get exactly one sandbox account per key** (`403 нельзя создать второй аккаунт в
  песочнице`). Its test campaigns, groups and creatives are generated *at creation time* and only
  if the account already has a valid contract — otherwise it is created with the warning
  `не удалось создать тестовые кампании, группы и креативы: актуальный договор аккаунта не найден`,
  and registering a contract afterwards does not backfill them. There is no second attempt.
- **Legal-entity validation is strict**: INN and OGRN are checksum-verified, addresses must look
  like `127015, г. Москва, ул. Лесная, д. 7`, phones like `+71234567890`.
- **`contact` really is `{name, email, phone}`** — the guess was right, the API validated the
  phone inside it.
- Quotas are per environment: production and the sandbox carry separate point balances
  (15000 and 10000 on the account we tested), and every call costs one point.
