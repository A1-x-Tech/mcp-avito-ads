# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-08-11

### Added

- First release. MCP server for the Avito Ads API (Avito Reklama — the media / performance
  advertising cabinet, not the Avito seller API), TypeScript over stdio, 25 tools:
  - **Account** — `get_account`, `get_balance`, `create_sandbox_account` (sandbox only).
  - **Child accounts and money** — `list_child_accounts`, `list_child_accounts_with_balances`,
    `create_child_account` (non-payer, returns its own API credentials once), `transfer_funds`,
    `transfer_bonus`.
  - **ORD paperwork** — `create_advertiser`, `list_advertisers`, `create_contract`,
    `list_contracts`.
  - **Campaigns, groups, creatives** — `list_campaigns`, `list_groups`, `list_creatives` (read-only,
    filtered and paginated) plus the only two writes the API offers on an ad object,
    `change_group_budget` and `change_group_price`.
  - **Statistics** — `campaign_stats`, `group_stats`, `creative_stats`.
  - **Users** — `list_users`, `add_user`, `set_user_role`, `delete_user`.
  - **Escape hatch** — `raw_request`, with `confirmWrite` required for POST/DELETE.
- OAuth2 `client_credentials` auth against `https://api.avito.ru/token`: the token is cached in
  memory, refreshed `AVITO_ADS_TOKEN_LEEWAY_SECONDS` early, shared by concurrent calls, and
  re-minted once on a 401.
- The weekly point quota is a first-class result: the `Api-Point-Balance` header is lifted into
  every tool result as `apiPointBalance` (the quota refills Mondays 00:00 UTC) — and into the
  error text too, next to `Retry-After`, so a 429 says how long to wait and what is left.
- Pre-flight validation so a malformed call spends no points: `YYYY-MM-DD` dates and the 100-day
  statistics cap, budget / bid / transfer minimums, the per-type contract rules
  (`service` / `intermediary` / `external`, additional agreements) and list page bounds.
- Resilience: retries with backoff honoring `Retry-After` — always on 429, and on 5xx / network
  errors for reads only, so a repeated funds transfer cannot move the money twice — plus a request
  timeout that also covers reading the response body.
- SSRF guard in the path resolver: an absolute URL, a backslash form or a `../` climbing out of
  the API base is refused before the request, so the Bearer token cannot reach another host or be
  replayed against the token endpoint. The same resolver pins the account: a `raw_request` path
  naming an account other than `AVITO_ADS_ACCOUNT_ID` is refused, `..` included.
- `create_sandbox_account` refuses to run unless `AVITO_ADS_ENVIRONMENT=sandbox`, and every
  request (the token call included) identifies itself with a `mcp-avito-ads/<version>` User-Agent.
- Sandbox support: `AVITO_ADS_ENVIRONMENT=sandbox` switches the path prefix to `ads-sandbox`;
  `AVITO_ADS_API_BASE` overrides the whole base for a local mock.
- Anonymous usage telemetry (`server_start`, `tool_call`, `startup_failed`) — ids, names and
  versions only, never credentials, account data or arguments; opt out with `ASKADS_TELEMETRY=0`.
- `npm run smoke`: a live read-only check (account, balance, one page of campaigns) that prints
  the remaining point balance after each step.
- Documentation: `README.md`, `docs/TOOLS.md`, `docs/DEVELOPMENT.md`, `docs/PUBLISHING.md`,
  `CLAUDE.md`.

[Unreleased]: https://github.com/A1-x-Tech/mcp-avito-ads/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/A1-x-Tech/mcp-avito-ads/releases/tag/v0.1.0
