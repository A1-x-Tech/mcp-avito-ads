import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AvitoAdsError } from "../types.js";
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  CONTRACT_ACTIONS,
  CONTRACT_COUNTERPARTY_TYPES,
  CONTRACT_SUBJECTS,
  CONTRACT_TYPES,
  CREATIVE_STATUSES,
  GROUP_STATUSES,
  LEGAL_ROLES,
  LEGAL_TYPES,
  PAYMENT_MODELS,
  USER_ROLES,
} from "../types.js";

/**
 * Everything below is a FACTORY (not a shared const): reusing one zod object
 * across two fields makes zod-to-json-schema dedupe them into a `$ref` (e.g.
 * dateTo → #/properties/dateFrom), which some tool-schema consumers (OpenAI
 * Apps review) don't dereference and flag as `any`. A fresh object per field
 * keeps each one inlined with its own type, pattern and description.
 */

/** A calendar date, YYYY-MM-DD — the format every Avito Ads date field uses. */
export const isoDate = () =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format, e.g. 2026-01-31");

/** Page size of a list endpoint: 1..100 (the API's own bounds). */
export const pageLimit = () => z.number().int().min(1).max(100);

/** 1-based page number of a list endpoint. */
export const pageNumber = () => z.number().int().min(1);

/** A positive integer entity id (campaign, group, creative, user, account). */
export const entityId = () => z.number().int().positive();

/** A list of positive integer entity ids. */
export const entityIds = () => z.array(z.number().int().positive());

/** A ruble amount the API accepts for budgets, bids and transfers (minimum 1). */
export const rubleAmount = () => z.number().min(1);

/** Free-form filter object passed straight through to a list endpoint. */
export const filterObject = () => z.record(z.any());

export const userRoleEnum = () => z.enum(USER_ROLES);
export const legalTypeEnum = () => z.enum(LEGAL_TYPES);
export const legalRoleEnum = () => z.enum(LEGAL_ROLES);
export const contractTypeEnum = () => z.enum(CONTRACT_TYPES);
export const contractSubjectEnum = () => z.enum(CONTRACT_SUBJECTS);
export const contractActionEnum = () => z.enum(CONTRACT_ACTIONS);
export const counterpartyTypeEnum = () => z.enum(CONTRACT_COUNTERPARTY_TYPES);
export const paymentModelEnum = () => z.enum(PAYMENT_MODELS);
export const campaignTypeEnum = () => z.enum(CAMPAIGN_TYPES);
export const campaignStatusEnum = () => z.enum(CAMPAIGN_STATUSES);
export const groupStatusEnum = () => z.enum(GROUP_STATUSES);
export const creativeStatusEnum = () => z.enum(CREATIVE_STATUSES);

/**
 * Wraps a value as a compact-JSON tool result (compact: the consumer is an LLM).
 * Client methods return `{ data, apiPointBalance }`, so passing that envelope
 * straight to `ok` hands the agent the remaining weekly quota with the answer.
 */
export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text", text: text ?? "null" }] };
}

/**
 * Renders an error for the agent. An API failure also reports what the response
 * itself said about coming back: `Retry-After` (the API is metered in weekly
 * points, so a 429 without a wait time is unanswerable) and the point balance
 * left, which every successful result carries and which the agent would
 * otherwise lose exactly when it matters.
 */
export function fail(err: unknown): CallToolResult {
  let message = err instanceof Error ? err.message : String(err);
  // Surface the underlying cause (e.g. the network error behind a timeout) — no
  // secrets live in cause, and it makes failures far easier to diagnose.
  if (err instanceof Error && err.cause instanceof Error) message += ` (${err.cause.message})`;
  if (err instanceof AvitoAdsError) {
    const hint = authHint(err);
    if (hint) message += ` — ${hint}`;
    if (err.retryAfter !== undefined) message += ` — retry after ${err.retryAfter}s`;
    if (err.apiPointBalance !== null) message += ` (apiPointBalance: ${err.apiPointBalance})`;
  }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * What a bare 401 or 403 from this API actually means.
 *
 * Avito answers a wrong account with `403 Forbidden` and an empty body, which
 * reads like a permissions problem and is not: the token is minted for exactly
 * one account, so a mismatched `AVITO_ADS_ACCOUNT_ID` fails this way and no
 * amount of re-issuing keys fixes it. The hint is only added when the API said
 * nothing itself — a 403 that carries its own message ("Ручка доступна только
 * для песочницы", "нельзя создать второй аккаунт в песочнице") is already
 * specific, and guessing over it would send the reader the wrong way.
 */
function authHint(err: AvitoAdsError): string | undefined {
  const body = err.body as { message?: unknown } | null | undefined;
  const apiExplained = typeof body?.message === "string" && body.message.trim() !== "";
  if (apiExplained) return undefined;
  if (err.status === 403) {
    return "the token is issued for a single account: check AVITO_ADS_ACCOUNT_ID is the account the key was created for";
  }
  if (err.status === 401) {
    return "the token was rejected: check AVITO_ADS_CLIENT_ID and AVITO_ADS_CLIENT_SECRET";
  }
  return undefined;
}

/**
 * MCP tool annotations — hints the consuming client can use to gate or label a
 * tool. All four hints are always set explicitly: some clients (OpenAI Apps
 * review) require readOnlyHint, destructiveHint and openWorldHint on every tool.
 */

/** Reads remote state and changes nothing; re-reading yields the same result. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Writes remote state, but only ever overwrites a field with the value given
 * (a budget, a bid, a role), so repeating the call lands on the same state and
 * nothing is lost. Use for the change-* and set-* tools.
 */
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Creates a new remote entity. Not destructive — nothing existing is harmed —
 * but repeating it produces a duplicate, so it is not idempotent. Use for the
 * create_* tools (advertiser, contract, child account, sandbox account).
 */
export const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Irreversible from the agent's side: deleting a user, or moving money and
 * bonuses between accounts (repeating a transfer moves the amount again).
 */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
