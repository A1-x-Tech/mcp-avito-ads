# Tools

25 tools over the Avito Ads API (`https://api.avito.ru/ads/`, or `/ads-sandbox/` in the sandbox).

Conventions that hold for every tool:

- **The account is fixed.** Every path is `v1/account/{accountID}/...` and the id comes from
  `AVITO_ADS_ACCOUNT_ID`. No tool takes an account id (`transfer_funds` / `transfer_bonus` take
  only the *destination*).
- **Every result is `{data, apiPointBalance}`**, serialized as compact JSON. `apiPointBalance` is
  the `Api-Point-Balance` header — the weekly points left, refilled Mondays 00:00 UTC — or `null`
  when the API did not send it. Errors come back as `isError: true` with the message text; an API
  failure also reports `Retry-After` (as the server sent it, uncapped) and the point balance the
  call failed with, which is what makes a 429 actionable.
- **List tools** are POST endpoints taking `{filter, limit, page}`; `limit` is 1..100 (default 20),
  `page` is 1-based (default 1). They return `{total, items, page, limit, hasNextPage}`.
- **Statistics tools** take an inclusive `dateFrom`/`dateTo` pair in `YYYY-MM-DD`, at most **100
  days** apart. The range is validated before the request, so a bad one costs no points.
- Money is in rubles. `budget`, `price` and transfer `amount` have a minimum of 1.

## Account

### `get_account`

Legal details of the configured ad account. **Inputs:** none.
**Output:** the account record — `inn`, `kpp`, `ogrn`, `shortName`, `longName`, `legalAddress`,
`actualAddress` and the contact / manager blocks. No money figures (see `get_balance`).
`GET v1/account/{accountID}`.

### `get_balance`

Current balance of the configured account, as a snapshot (not a history).
**Inputs:** none. **Output:** `{balance, bonusBalance}` — real rubles and bonus rubles, which are
spendable on ads only. `GET v1/account/{accountID}/balance`.

### `create_sandbox_account`

**Sandbox only** — creates a test advertiser account. This server refuses the call unless
`AVITO_ADS_ENVIRONMENT=sandbox`, and the refusal costs no API point; the endpoint posts to the
*configured* account's path, so it is not something to try against production. The running server
keeps using `AVITO_ADS_ACCOUNT_ID`: the new id is not adopted.

**You get one shot.** A second call answers `403 нельзя создать второй аккаунт в песочнице` — the
sandbox allows exactly one account per key. The test campaigns, groups and creatives that make the
sandbox useful are generated *at creation time*, and only if the account already has a valid
contract; otherwise the account is still created, but with the warning `не удалось создать тестовые
кампании, группы и креативы: актуальный договор аккаунта не найден`, and registering a contract
afterwards does not backfill them.

Field formats are validated server-side and rejections are strict: `inn` and `ogrn` are
checksum-verified, addresses must look like `127015, г. Москва, ул. Лесная, д. 7`, and the phone
inside `contact` like `+71234567890`.

| Input | Type | Required | Notes |
|---|---|---|---|
| `inn` | string | yes | 10 digits for a company, 12 for a sole proprietor. |
| `shortName` | string | yes | Short legal name. |
| `longName` | string | yes | Full legal name. |
| `ogrn` | string | yes | OGRN (company) / OGRNIP (sole trader). |
| `legalAddress` | string | yes | Registered address. |
| `actualAddress` | string | yes | Postal address; may repeat `legalAddress`. |
| `contact` | object | yes | Non-empty; keys are `name` / `email` / `phone`, passed through as-is. The API validates the phone inside it. |
| `kpp` | string | no | Companies (`ul`) only. |
| `legalType` | `ul` \| `ip` | no | Company or sole proprietor. |

**Output:** the created account, including its `accountID`. `POST v1/account/{accountID}`.

## Child accounts and money

### `list_child_accounts`

Child (sub-)accounts of the configured agency account. **Inputs:** none — no paging, no filter.
**Output:** an array of `{account: {id, shortName}, contract}`. Balances are not included.
`GET v1/account/{accountID}/children`.

### `list_child_accounts_with_balances`

The same list plus each child's `{balance, bonusBalance}`. **Inputs:** none. Use it to see which
child is out of money before a transfer, and to verify one landed.
`GET v1/account/{accountID}/children-with-balances`.

### `create_child_account`

Creates a **non-payer** child account under the configured agency account. Non-payer means it
cannot top itself up — fund it with `transfer_funds`.

| Input | Type | Required | Notes |
|---|---|---|---|
| `shortName` | string | yes | Display name of the new account. |
| `isSelfAdvertisingEnabled` | boolean | yes | Whether the child may advertise its own goods and services. |

**Output:** `{accountID, clientKey, clientSecret}` — the child's own API credentials, handed out
**only here**; store them immediately, they cannot be re-read.
`POST v1/account/{accountID}/create-nonpayer-child-account`.

### `transfer_funds`

Moves **real money** out of the configured account into another one (normally a child).
Destructive: no undo, no cancel, no transfer log.

| Input | Type | Required | Notes |
|---|---|---|---|
| `accountIdTo` | integer | yes | Destination account id. The sender is always the configured account. |
| `amount` | number | yes | Rubles, minimum 1. |

**Output:** an empty data object on success — treat any non-error response as done and never
repeat the call. After a network or server error the outcome is unknown: check
`list_child_accounts_with_balances` before retrying. `POST v1/account/{accountID}/funds-transfer`.

### `transfer_bonus`

Same as `transfer_funds` but moves bonus rubles (`bonusBalance` — promotional funds that buy ads
and cannot be withdrawn as cash). Inputs `accountIdTo`, `amount` (minimum 1).
`POST v1/account/{accountID}/bonus-transfer`.

## ORD: advertisers and contracts

Russian ad-marking law requires every campaign to name a registered advertiser and the contract it
runs under. Both entities are **append-only** here — no edit, no delete.

### `create_advertiser`

Registers an advertiser (an ORD counterparty).

| Input | Type | Required | Notes |
|---|---|---|---|
| `inn` | string | yes | 10 digits for `ul`, 12 for `ip`. |
| `shortName` / `longName` | string | yes | Legal names. |
| `ogrn` | string | yes | OGRN (company) / OGRNIP (sole trader). |
| `legalAddress` / `actualAddress` | string | yes | Registered and postal address. |
| `legalRole` | `rd` \| `ra` \| `rr` | yes | Advertiser / agency / distributor. |
| `legalType` | `ul` \| `ip` | yes | Company / sole trader. |
| `kpp` | string | no | Companies (`ul`) only. |

**Output:** `{id}` — the id campaigns and contracts reference.
`POST v1/account/{accountID}/create-advertiser`.

### `list_advertisers`

One page of registered advertisers. There is no free-text search — match on names yourself.

| Input | Type | Notes |
|---|---|---|
| `filter.ids` | integer[] | Only these advertiser ids. |
| `filter.inns` | string[] | Only these taxpayer numbers. |
| `filter.roles` | (`rd`\|`ra`\|`rr`)[] | Only these ORD roles. |
| `limit` / `page` | integer | 1..100 (default 20) / 1-based. |

Unknown filter keys pass through untouched. **Output:** a page of items carrying `id`,
`shortName`, `longName`, `inn`, `ogrn`, `kpp`, `legalAddress`, `actualAddress`, `legalType`,
`legalRole`. `POST v1/account/{accountID}/advertisers`.

### `create_contract`

Registers an ORD contract between the account and an advertiser. Which fields are mandatory
depends on `type`; the rules are enforced before the request, so a wrong combination costs no
points:

| `type` | Requires | Rejects |
|---|---|---|
| `service` | `subject`, `isReportingRequired`, `date`, `number` | `cid` |
| `intermediary` | the above plus `object`, `isFundsAllocationToPrincipal` | `cid` |
| `external` | `cid` | `parentId` |

| Input | Type | Notes |
|---|---|---|
| `advertiserId` | integer | Required. The client, from `list_advertisers`. |
| `type` | `service` \| `intermediary` \| `external` | Required. |
| `counterpartyType` | `direct_with_advertiser` \| `advertiser_intermediary` | Required. Sent as the API's `description` field. |
| `subject` | `org-distribution` \| `mediation` \| `distribution` \| `representation` \| `other` | Per the table above. |
| `object` | `distribution` \| `conclude` \| `commercial` \| `other` | The contract action. |
| `cid` | string | External contract id (ERID-side). |
| `date` | string | `YYYY-MM-DD`. |
| `number` | string | Contract number. |
| `isReportingRequired` | boolean | Acts / reports required. |
| `isFundsAllocationToPrincipal` | boolean | Funds allocated to the principal. |
| `parentId` | integer | Set it to register an **additional agreement**; then `intermediary` must be omitted. |
| `intermediary` | object | Contractor's legal details (`inn` required; `shortName`, `longName`, `ogrn`, `kpp`, `legalAddress`, `actualAddress`, `legalType`, plus any extra keys). Required unless `parentId` is set. |

**Output:** `{id}`. `POST v1/account/{accountID}/create-contract`.

### `list_contracts`

One page of registered contracts.

| Input | Type | Notes |
|---|---|---|
| `filter.ids` | integer[] | Only these contract ids. |
| `filter.numbers` | string[] | Only these contract numbers. |
| `filter.clients` | integer[] | Only contracts whose client is one of these advertiser ids. |
| `filter.contractors` | integer[] | Only these contractor (intermediary) ids. |
| `limit` / `page` | integer | 1..100 (default 20) / 1-based. |

**Output:** a page of items carrying `id`, `type`, `number`, `date`, `subject`, `object`, `cid`,
`description` (the counterparty type), `parentId` on additional agreements, and the client /
contractor legal details. `POST v1/account/{accountID}/contracts`.

## Campaigns, groups, creatives

Read-only, plus two writes on an ad group. Campaigns, groups and creatives cannot be created,
edited, paused, resumed, archived or deleted, and targeting is not exposed.

All three list tools share the same shape: named filter fields (all AND-ed, each keeping only the
values it names), a raw `filter` escape hatch merged underneath them (named fields win), plus
`limit` and `page`. The id lists are renamed onto their wire spelling (`campaignIds` →
`campaignIDs`, `groupIds` → `groupIDs`, `contractIds` → `contractIDs`, `additionalAgreementIds` →
`additionalAgreementIDs`). Date-range filters are `{from, to}` with both ends `YYYY-MM-DD`.

### `list_campaigns`

| Input | Type | Notes |
|---|---|---|
| `ids` | integer[] | Campaign ids to keep. |
| `statuses` | string[] | `draft`, `in_moderation`, `moderation_failed`, `partial_moderation`, `active`, `paused`, `stopped`, `finished`, `archived`. |
| `campaignTypes` | (`textImage`\|`HTML`\|`video`)[] | |
| `paymentModels` | (`CPM`\|`CPC`)[] | |
| `advertisers` / `managers` | integer[] | Advertiser / manager (account user) ids. |
| `contractIds` / `additionalAgreementIds` | integer[] | ORD document ids. |
| `createdAt` | `{from, to}` | Creation date range. |
| `timeFrame` | `{from, to}` | Flight window range. |
| `filter` | object | Extra filter keys in API spelling. |
| `limit` / `page` | integer | 1..100 (default 20) / 1-based. |

**Output:** a page of campaigns with `id`, `name`, `status`, `budget`, `paymentModel`,
`campaignType`, `startDate` / `endDate`, `advertiserId`, `contractId`, `managerID` and timestamps.
`POST v1/account/{accountID}/campaigns`.

### `list_groups`

The ad group is the level that holds the money.

| Input | Type | Notes |
|---|---|---|
| `ids` | integer[] | Ad group ids to keep. |
| `campaignIds` | integer[] | Groups of these campaigns. |
| `statuses` | string[] | `draft`, `in_moderation`, `moderation_failed`, `will_launch_soon`, `active`, `will_stop_soon`, `pausing`, `paused`, `unpausing`, `stopped`, `finished`, `archived`. |
| `paymentModels` | (`CPM`\|`CPC`)[] | |
| `paces` | string[] | Budget pacing modes; free-form — the SDK documents no fixed vocabulary. |
| `advertisers` / `managers` | integer[] | |
| `timeFrame` | `{from, to}` | Flight window range. |
| `filter` | object | Extra filter keys. |
| `limit` / `page` | integer | |

**Output:** a page of groups with `id`, `name`, `campaignID`, `status`, `budget` and `price` (the
bid) in rubles, `paymentModel`, `campaignType`, `advertiserID`, `haveCreative` and timestamps.
`POST v1/account/{accountID}/groups`.

### `list_creatives`

| Input | Type | Notes |
|---|---|---|
| `ids` | integer[] | Creative ids to keep. |
| `groupIds` / `campaignIds` | integer[] | Creatives of these groups / campaigns. |
| `statuses` | string[] | `draft`, `ready_for_moderation`, `in_moderation`, `moderation_failed`, `erir_registration`, `active`, `paused`, `stopped`, `finished`, `archived`. |
| `campaignTypes` | (`textImage`\|`HTML`\|`video`)[] | |
| `paymentModels` | (`CPM`\|`CPC`)[] | |
| `advertisers` / `managers` | integer[] | |
| `timeFrame` | `{from, to}` | Flight window range. |
| `filter` | object | Extra filter keys. |
| `limit` / `page` | integer | |

**Output:** a page of creatives with `id`, `name`, `title`, `description`, `buttonText`, `link`,
`status`, `groupID`, `campaignID`, `advertiserID`, `paymentModel`, `campaignType` and `legalInfo`
(the ad-registry / ERID data). `POST v1/account/{accountID}/creatives`.

### `change_group_budget`

Sets one ad group's budget. The value **replaces** the current budget rather than adding to it, so
repeating the call is safe. Only groups on manual bid management accept it.

| Input | Type | Notes |
|---|---|---|
| `groupId` | integer | From `list_groups`. |
| `budget` | number | Rubles, at least 1. |

**Output:** the API's acknowledgement. `POST v1/account/{accountID}/group/{groupID}/change-budget`.

### `change_group_price`

Sets one ad group's bid (the API calls it `price`). The unit follows the group's `paymentModel`:
rubles per 1000 impressions for CPM, rubles per click for CPC. Replaces, does not add. Manual bid
management only.

| Input | Type | Notes |
|---|---|---|
| `groupId` | integer | From `list_groups`. |
| `price` | number | Rubles, at least 1. |

**Output:** the API's acknowledgement. `POST v1/account/{accountID}/group/{groupID}/change-price`.

## Statistics

Metrics in every row: `views` (impressions), `clicks`, `ctr`, `spend`, `spendBonus`, `cpm`, `cpc`
and, for video campaigns, `videoViews25/50/75/100`, `q25/q50/q75`, `vtr`. Money is in rubles;
rates pass through exactly as the API reports them. Each entity carries `data[]` (one row per day,
stamped with `timestamp`) and `totalData` (the period aggregate). There is no sub-day granularity
and no aggregation across campaigns.

### `campaign_stats`

Statistics for **one** campaign with its per-group and per-creative breakdowns.

| Input | Type | Notes |
|---|---|---|
| `campaignId` | integer | From `list_campaigns`. |
| `dateFrom` / `dateTo` | `YYYY-MM-DD` | Inclusive; at most 100 days apart. |

**Output:** `{campaign, groups[], creatives[]}`.
`POST v1/account/{accountID}/campaigns/{campaignID}/stats`.

### `group_stats`

Per-group statistics for the groups you name in one campaign — a flat array of
`{id, name, paymentModel, campaignType, data[], totalData}`, with no campaign-level totals. This
tool narrows, it does not enumerate: `campaign_stats` already carries the breakdown for every
group. The id list is sent as the API's `groupIDs` and is passed through exactly as given — the
SDK makes it a required argument and documents no meaning for an empty one.

| Input | Type | Notes |
|---|---|---|
| `campaignId` | integer | Required. |
| `dateFrom` / `dateTo` | `YYYY-MM-DD` | Required, inclusive, ≤ 100 days. |
| `groupIds` | integer[] | Required. The groups to report on; use `campaign_stats` for all of them. |

`POST v1/account/{accountID}/campaigns/{campaignID}/groups/stats`.

### `creative_stats`

Per-creative statistics for the creatives you name in one campaign — a flat array of
`{id, name, groupId, paymentModel, campaignType, data[], totalData}`. Same rule as `group_stats`:
the id list is required and passed through as the API's `creativeIDs`; `campaign_stats` is the way
to get every creative of a campaign.

| Input | Type | Notes |
|---|---|---|
| `campaignId` | integer | Required. |
| `dateFrom` / `dateTo` | `YYYY-MM-DD` | Required, inclusive, ≤ 100 days. |
| `creativeIds` | integer[] | Required. The creatives to report on; use `campaign_stats` for all of them. |

`POST v1/account/{accountID}/campaigns/{campaignID}/creatives/stats`.

## Users

Scoped to the configured account — these tools cannot manage the users of a child account.

### `list_users`

**Inputs:** none. **Output:** one `{id, role, hasLoggedIn}` per user, where `role` is `admin` or
`viewer` and `hasLoggedIn` says whether the invited person has ever signed in.
`GET v1/account/{accountID}/users`.

### `add_user`

Grants an existing Avito user access. Cannot invite by email or phone and cannot create an Avito
account; if the user already has access, use `set_user_role`.

| Input | Type | Notes |
|---|---|---|
| `userId` | integer | Numeric Avito user id. |
| `role` | `admin` \| `viewer` | `admin` = full access (users, transfers, campaign edits); `viewer` = read-only. |

`POST v1/account/{accountID}/add-user`.

### `set_user_role`

Changes the role of a user who already has access. Applying the role they already hold is a no-op.
It neither grants nor revokes access. Inputs `userId`, `role`.
`POST v1/account/{accountID}/set-user-role`.

### `delete_user`

Revokes a user's access. Destructive: the only way back is `add_user` with an explicit role. It
does not delete the person's Avito account, their campaigns or their spend history.
**Input:** `userId`. `DELETE v1/account/{accountID}/delete-user/{userID}`.

## Escape hatch

### `raw_request`

Calls any Avito Ads API path directly, for endpoints without a dedicated tool.

| Input | Type | Notes |
|---|---|---|
| `path` | string | Relative to the API base, e.g. `v1/account/{accountID}/groups`. The literal `{accountID}` placeholder is substituted with the configured account id. |
| `method` | `GET` \| `POST` \| `DELETE` | Default `GET`. |
| `body` | object | Sent as JSON. Rejected on `GET` — this API serves its filtered reads over POST. |
| `confirmWrite` | boolean | Must be `true` for `POST` and `DELETE`, which this API also uses for list and statistics reads. |

A path that resolves to a foreign origin, or that climbs out of the API base (`../token`), is
refused before any request goes out — the Bearer token cannot leak to another host. So is a path
that addresses another account (`v1/account/999/funds-transfer`): the check runs on the resolved
path, so `..` cannot dodge it, and the account id stays what `AVITO_ADS_ACCOUNT_ID` says it is.
The tool is annotated **destructive** because it can reach every write endpoint, funds transfer
and `delete_user` included, with none of the client-side validation the dedicated tools apply —
and its description says so, because that is the only text the model reads.
**Output:** the raw response body plus `apiPointBalance`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AVITO_ADS_CLIENT_ID` | yes | — | OAuth2 client id (Client Key). |
| `AVITO_ADS_CLIENT_SECRET` | yes | — | OAuth2 client secret. Treat as a password. |
| `AVITO_ADS_ACCOUNT_ID` | yes | — | Ad account id, a positive integer (digits only). |
| `AVITO_ADS_ENVIRONMENT` | no | `production` | `production` or `sandbox` (`ads` / `ads-sandbox` prefix). |
| `AVITO_ADS_TIMEOUT_MS` | no | `30000` | Per-request timeout, ms; covers reading the body. |
| `AVITO_ADS_MAX_RETRIES` | no | `4` | Retries on 429 (always) and on 5xx / network for reads. |
| `AVITO_ADS_TOKEN_LEEWAY_SECONDS` | no | `60` | Refresh the token this long before expiry. |
| `AVITO_ADS_API_BASE` | no | `https://api.avito.ru/ads/` | API root override; replaces the environment prefix. |
