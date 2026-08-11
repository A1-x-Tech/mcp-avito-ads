# Avito Ads MCP

[![npm](https://img.shields.io/npm/v/mcp-avito-ads)](https://www.npmjs.com/package/mcp-avito-ads)
[![CI](https://github.com/A1-x-Tech/mcp-avito-ads/actions/workflows/ci.yml/badge.svg)](https://github.com/A1-x-Tech/mcp-avito-ads/actions/workflows/ci.yml)
[![Glama](https://glama.ai/mcp/servers/A1-x-Tech/mcp-avito-ads/badges/score.svg)](https://glama.ai/mcp/servers/A1-x-Tech/mcp-avito-ads)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MCP server for the **Avito Ads API (Avito Reklama)** — the media / performance advertising
cabinet. Ask Claude, Cursor, Codex or any other MCP client about your campaigns, ad groups,
creatives and their statistics in plain language; move money between agency sub-accounts and
file the ORD paperwork without opening the web cabinet.

> **This is not the Avito seller API.** Avito Ads is the advertising cabinet (display and
> performance campaigns bought by an advertiser or an agency). Listings, chats with buyers,
> orders and item promotion live behind a different API — the community server
> [`avito-mcp`](https://www.npmjs.com/search?q=avito-mcp) covers those, and its credentials are
> not interchangeable with these. If you came here to answer a buyer's message, you are in the
> wrong repository.

## Quick start

1. [Get a Client Key and Client Secret](#getting-access) in the Avito Ads cabinet
   (Administrator role required) and note your ad account id.
2. Add the server — for example, to Claude Code ([other clients](#installation)):

   ```bash
   claude mcp add avito-ads \
     -e AVITO_ADS_CLIENT_ID=your_client_key \
     -e AVITO_ADS_CLIENT_SECRET=your_client_secret \
     -e AVITO_ADS_ACCOUNT_ID=your_account_id \
     -- npx -y mcp-avito-ads@latest
   ```

3. Ask the assistant: "Show me the campaigns of my Avito account and last week's spend per group."

## What it can do

- **Ad objects (read-only)** — `list_campaigns`, `list_groups`, `list_creatives`: paginated,
  filterable lists of campaigns, ad groups and the creatives themselves, with status, budget,
  bid, payment model, flight dates and ORD legal info.
- **Statistics** — `campaign_stats`, `group_stats`, `creative_stats`: impressions, clicks, CTR,
  spend, bonus spend, CPM, CPC and the video quartiles / VTR, per day and as a period total.
- **Money knobs** — `change_group_budget` and `change_group_price`: the budget and the bid of one
  ad group. These are the **only** editable fields in the whole ad object tree.
- **Account, balances and agency sub-accounts** — `get_account`, `get_balance`, `list_child_accounts`,
  `list_child_accounts_with_balances`, `create_child_account`, `transfer_funds`, `transfer_bonus`.
- **ORD paperwork** — `create_advertiser`, `list_advertisers`, `create_contract`, `list_contracts`:
  the advertiser and contract records Russian ad-marking law requires before a campaign can run.
- **Account access** — `list_users`, `add_user`, `set_user_role`, `delete_user`.
- **Universal `raw_request`** — call any API path directly, for endpoints without a dedicated tool.

Full reference: [docs/TOOLS.md](https://github.com/A1-x-Tech/mcp-avito-ads/blob/main/docs/TOOLS.md) — 25 tools.

## What it cannot do

The Avito Ads API surface is deliberately narrow, and no MCP server can widen it:

- **Campaigns, ad groups and creatives cannot be created, edited, paused, resumed, archived or
  deleted** through the API. That work stays in the web cabinet.
- **Targeting is not exposed at all** — neither for reading nor for writing.
- **Creatives cannot be uploaded** or sent to moderation.
- **Advertisers and contracts are append-only** — there is no edit and no delete endpoint, so a
  wrong record stays on the account.
- **Money transfers cannot be undone.** There is no cancel endpoint and no transfer log.
- The account is fixed by `AVITO_ADS_ACCOUNT_ID`; no tool takes an account id, so a model cannot
  wander into another account (`transfer_funds` picks only the *destination*).

## The weekly point quota

This is the single most surprising operational fact about the Avito Ads API, so plan around it:

- Every call spends **points from a weekly budget**, not from a per-second rate limit.
- The budget is **replenished on Mondays at 00:00 UTC**. Burn it on Tuesday and the account is
  effectively read-nothing until the next Monday.
- Every response carries an `Api-Point-Balance` header, and this server lifts it into **every tool
  result** as `apiPointBalance` (`null` if the API did not send the header). The assistant sees the
  remaining budget with every answer and can pace itself.

Practical consequences worth telling your assistant about:

- Prefer **one wide statistics period** over many narrow ones — the 100-day cap per request exists
  precisely so a long report is a single call.
- Use `limit` up to 100 instead of walking pages of 20.
- Client-side validation (dates, amounts, contract rules, page bounds) is done **before** the
  request, so a malformed call costs no points.
- On an HTTP 429 the error itself reports `Retry-After` (as the server sent it) and the point
  balance the call failed with, so the assistant knows when it can come back.

## Examples

- "How much did campaign 4242 spend last month, broken down by ad group?"
- "Which of my child accounts is out of money?"
- "Raise the bid of ad group 101 to 350 rubles."
- "List the creatives that failed moderation."
- "Register the advertiser with INN 7707083893 and a service contract for it."

## Installation

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add avito-ads \
  -e AVITO_ADS_CLIENT_ID=your_client_key \
  -e AVITO_ADS_CLIENT_SECRET=your_client_secret \
  -e AVITO_ADS_ACCOUNT_ID=your_account_id \
  -- npx -y mcp-avito-ads@latest
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

`claude_desktop_config.json` — macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`

```json
{
  "mcpServers": {
    "avito-ads": {
      "command": "npx",
      "args": ["-y", "mcp-avito-ads@latest"],
      "env": {
        "AVITO_ADS_CLIENT_ID": "your_client_key",
        "AVITO_ADS_CLIENT_SECRET": "your_client_secret",
        "AVITO_ADS_ACCOUNT_ID": "your_account_id"
      }
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in the project)

```json
{
  "mcpServers": {
    "avito-ads": {
      "command": "npx",
      "args": ["-y", "mcp-avito-ads@latest"],
      "env": {
        "AVITO_ADS_CLIENT_ID": "your_client_key",
        "AVITO_ADS_CLIENT_SECRET": "your_client_secret",
        "AVITO_ADS_ACCOUNT_ID": "your_account_id"
      }
    }
  }
}
```

</details>

<details>
<summary><b>VS Code</b></summary>

`.vscode/mcp.json` — the key is `servers` (not `mcpServers`)

```json
{
  "servers": {
    "avito-ads": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-avito-ads@latest"],
      "env": {
        "AVITO_ADS_CLIENT_ID": "your_client_key",
        "AVITO_ADS_CLIENT_SECRET": "your_client_secret",
        "AVITO_ADS_ACCOUNT_ID": "your_account_id"
      }
    }
  }
}
```

</details>

## Getting access

1. Open the **Avito Ads cabinet** with a user that has the **Administrator** role on the ad
   account — a viewer cannot issue API credentials.
2. Create an API application there and copy its **Client Key** and **Client Secret**. They are the
   OAuth2 `client_credentials` pair this server exchanges for a Bearer token at
   `https://api.avito.ru/token`.
3. Note the **ad account id** the credentials belong to — every API path is scoped to it
   (`v1/account/{accountID}/...`).
4. Put them into `AVITO_ADS_CLIENT_ID`, `AVITO_ADS_CLIENT_SECRET` and `AVITO_ADS_ACCOUNT_ID`.

⚠️ The secret is stored in **plain text** in the MCP client's config — treat it as a password.
The agency child accounts created by `create_child_account` come with their own fresh
`clientKey` / `clientSecret`, returned **once** and not re-readable afterwards.

### Sandbox

Set `AVITO_ADS_ENVIRONMENT=sandbox` and the server talks to `https://api.avito.ru/ads-sandbox/`
instead of `https://api.avito.ru/ads/`. Use it to rehearse the write tools without touching real
money. `create_sandbox_account` mints a test account there — the server refuses that tool unless
`AVITO_ADS_ENVIRONMENT=sandbox` — and the returned id is **not** adopted by the running server:
put it into `AVITO_ADS_ACCOUNT_ID` to use it.

Three things worth knowing before you spend the attempt, none of them documented upstream:

- **One account per key.** A second `create_sandbox_account` answers `403 нельзя создать второй
  аккаунт в песочнице`.
- **Test data is generated once, at creation, and only if the account already has a valid
  contract.** Without one the account is created with a warning and stays empty — no campaigns, no
  groups, no statistics to read — and registering a contract afterwards does not backfill it.
- **The sandbox is not a full mirror**: `get_balance` answers `404` there.

Quotas are per environment: production and the sandbox each carry their own weekly point balance.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `AVITO_ADS_CLIENT_ID` | yes | — | OAuth2 client id (Client Key) of your Avito application. |
| `AVITO_ADS_CLIENT_SECRET` | yes | — | OAuth2 client secret. Treat as a password. |
| `AVITO_ADS_ACCOUNT_ID` | yes | — | Ad account id, a positive integer. Injected into every path. |
| `AVITO_ADS_ENVIRONMENT` | no | `production` | `production` or `sandbox`. |
| `AVITO_ADS_TIMEOUT_MS` | no | `30000` | Per-request timeout, ms (covers reading the body). |
| `AVITO_ADS_MAX_RETRIES` | no | `4` | Retries on 429; on 5xx/network for reads only. |
| `AVITO_ADS_TOKEN_LEEWAY_SECONDS` | no | `60` | Refresh the access token this long before it expires. |
| `AVITO_ADS_API_BASE` | no | `https://api.avito.ru/ads/` | API root override (replaces the environment prefix too). |

The variable names match the official [Avito Ads SDK](https://github.com/avito-tech/avito-ads-sdk-typescript),
so one set of credentials works for both.

## Requirements

- Node.js 20+ (run through `npx`, no separate install needed).
- An Avito Ads account with API credentials — see [Getting access](#getting-access).

## Safety

- Writes are grouped by intent through MCP tool annotations: reads are `readOnlyHint`, budget /
  bid / role changes are idempotent writes, creates are non-idempotent, and money transfers plus
  `delete_user` are marked **destructive** — clients that ask for confirmation will ask for these.
- `raw_request` requires an explicit `confirmWrite: true` for `POST` and `DELETE`, refuses any
  path that escapes the API base (SSRF guard), so the Bearer token cannot be sent to another host,
  and refuses any path addressing an account other than `AVITO_ADS_ACCOUNT_ID` — including one that
  tries to get there through `..`.
- Writes are never retried after a network error or a 5xx — a repeated funds transfer would move
  the money twice. Reads are retried with backoff.

## Documentation

- [All tools](https://github.com/A1-x-Tech/mcp-avito-ads/blob/main/docs/TOOLS.md) — full reference with inputs and outputs.
- [Development](https://github.com/A1-x-Tech/mcp-avito-ads/blob/main/docs/DEVELOPMENT.md) — build, tests, smoke check, telemetry.
- [Publishing](https://github.com/A1-x-Tech/mcp-avito-ads/blob/main/docs/PUBLISHING.md) — release and MCP-catalog listing.

## See also

- **[Ask Ads](https://askads.ru)** — a chat analyst and watchdog for ad accounts by the authors of
  this server: budget-burn and tracking-breakage alerts in Telegram.
- **[Avito Ads SDK for TypeScript](https://github.com/avito-tech/avito-ads-sdk-typescript)** — the
  official SDK; this server implements the same wire protocol independently.

## Support

Questions, ideas and feature requests — Telegram: [@gistrec](http://t.me/gistrec).

## License

MIT — see [LICENSE](./LICENSE).
