/**
 * Config, wire types and errors for the Avito Ads API (Avito Reklama).
 *
 * The server talks to https://api.avito.ru/ads/ (or /ads-sandbox/ in the
 * sandbox). Auth is OAuth2 client_credentials against https://api.avito.ru/token
 * exchanged for a `Bearer` token; every path is account-scoped
 * (`v1/account/{accountID}/...`) with the account id coming from the config,
 * never from a tool argument.
 *
 * Field names below mirror the JSON the API emits, including its inconsistent
 * casing (`accountID` here, `accountId` there) — do not "fix" them.
 */

/** API environment; selects the `ads` or `ads-sandbox` path prefix. */
export type Environment = "production" | "sandbox";

export interface AvitoAdsConfig {
  /** OAuth2 client id of the Avito application. Treated as a secret. */
  clientId: string;
  /** OAuth2 client secret of the Avito application. Treated as a secret. */
  clientSecret: string;
  /** Ad account the token is bound to; injected into every path. */
  accountId: number;
  /** Which API environment the base url points at (reported by tools). */
  environment: Environment;
  /** API root, including the environment prefix, e.g. https://api.avito.ru/ads/. */
  apiBase: string;
  /** Per-request timeout in milliseconds. Defaults to 30_000. */
  timeoutMs?: number;
  /** Max retries for transient failures (429, 5xx on reads, network). Defaults to 4. */
  maxRetries?: number;
  /** Base backoff in milliseconds, doubled each retry. Defaults to 500. */
  retryBaseMs?: number;
  /** How early to refresh the access token, in seconds. Defaults to 60. */
  tokenLeewaySeconds?: number;
  /**
   * `User-Agent` sent on every API and token request, so Avito can tell this
   * server from an unidentified script. Defaults to `mcp-avito-ads`; index.ts
   * passes the package version with it.
   */
  userAgent?: string;
}

// --- Enumerations (values the API accepts; kept as const tuples so tools can
// build zod enums from them without restating the vocabulary). ---

/** Legal entity type of a counterparty. */
export const LEGAL_TYPES = ["ul", "ip"] as const;
export type LegalType = (typeof LEGAL_TYPES)[number];

/** Counterparty role in the ORD (ad registry) sense: advertiser / agency / distributor. */
export const LEGAL_ROLES = ["rd", "ra", "rr"] as const;
export type LegalRole = (typeof LEGAL_ROLES)[number];

/** Role of a user inside the ad account. */
export const USER_ROLES = ["admin", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Contract type. */
export const CONTRACT_TYPES = ["service", "intermediary", "external"] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/** Contract subject. */
export const CONTRACT_SUBJECTS = [
  "org-distribution",
  "mediation",
  "distribution",
  "representation",
  "other",
] as const;
export type ContractSubject = (typeof CONTRACT_SUBJECTS)[number];

/** Contract action — the API's `object` field. */
export const CONTRACT_ACTIONS = ["distribution", "conclude", "commercial", "other"] as const;
export type ContractAction = (typeof CONTRACT_ACTIONS)[number];

/** Counterparty type — the API's `description` field. */
export const CONTRACT_COUNTERPARTY_TYPES = ["direct_with_advertiser", "advertiser_intermediary"] as const;
export type ContractCounterpartyType = (typeof CONTRACT_COUNTERPARTY_TYPES)[number];

/** Payment model of a campaign / group / creative. */
export const PAYMENT_MODELS = ["CPM", "CPC"] as const;
export type PaymentModel = (typeof PAYMENT_MODELS)[number];

/** Campaign type. */
export const CAMPAIGN_TYPES = ["textImage", "HTML", "video"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

/** Campaign status. */
export const CAMPAIGN_STATUSES = [
  "draft",
  "in_moderation",
  "moderation_failed",
  "partial_moderation",
  "active",
  "paused",
  "stopped",
  "finished",
  "archived",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Ad group status. */
export const GROUP_STATUSES = [
  "draft",
  "in_moderation",
  "moderation_failed",
  "will_launch_soon",
  "active",
  "will_stop_soon",
  "pausing",
  "paused",
  "unpausing",
  "stopped",
  "finished",
  "archived",
] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

/** Creative status. */
export const CREATIVE_STATUSES = [
  "draft",
  "ready_for_moderation",
  "in_moderation",
  "moderation_failed",
  "erir_registration",
  "active",
  "paused",
  "stopped",
  "finished",
  "archived",
] as const;
export type CreativeStatus = (typeof CREATIVE_STATUSES)[number];

// --- Response models ---

/** Legal details of an ad account. */
export interface Account {
  inn?: string;
  shortName?: string;
  longName?: string;
  ogrn?: string;
  kpp?: string;
  legalAddress?: string;
  actualAddress?: string;
  contact?: Record<string, unknown>;
  manager?: Record<string, unknown>;
}

/** Account balance: rubles and bonus rubles, both integers. */
export interface Balance {
  balance: number;
  bonusBalance: number;
}

/** Advertiser (a counterparty registered under the account). */
export interface Advertiser {
  id?: number;
  shortName?: string;
  longName?: string;
  inn?: string;
  ogrn?: string;
  kpp?: string;
  legalAddress?: string;
  actualAddress?: string;
  legalType?: string;
  legalRole?: string;
  accountId?: number;
}

/** Contract between the account and an advertiser. */
export interface Contract {
  id?: number;
  accountID?: number;
  client?: Advertiser;
  contractor?: Advertiser;
  type?: string;
  date?: string;
  number?: string;
  subject?: string;
  object?: string;
  cid?: string;
  description?: string;
  parentId?: number;
}

/** Ad campaign. */
export interface Campaign {
  id?: number;
  name?: string;
  status?: string;
  budget?: number;
  paymentModel?: string;
  campaignType?: string;
  startDate?: string;
  endDate?: string;
  userId?: number;
  accountId?: number;
  advertiserId?: number;
  contractId?: number;
  managerID?: number;
  additionalAgreementID?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Ad group (the level that carries budget and bid). */
export interface Group {
  id?: number;
  name?: string;
  accountID?: number;
  campaignID?: number;
  status?: string;
  budget?: number;
  price?: number;
  paymentModel?: string;
  campaignType?: string;
  advertiserID?: number;
  managerID?: number;
  haveCreative?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Creative (the ad itself). */
export interface Creative {
  id?: number;
  name?: string;
  title?: string;
  description?: string;
  buttonText?: string;
  link?: string;
  status?: string;
  groupID?: number;
  campaignID?: number;
  accountID?: number;
  advertiserID?: number;
  managerID?: number;
  paymentModel?: string;
  campaignType?: string;
  legalInfo?: Record<string, unknown>;
}

/** A user with access to the ad account. */
export interface User {
  id?: number;
  role?: string;
  hasLoggedIn?: boolean;
}

/** Child account; its own details are nested under `account`. */
export interface ChildAccount {
  account?: {
    id?: number;
    shortName?: string;
  };
  contract?: Record<string, unknown>;
  balance?: Balance;
}

/** Result of creating a contract. */
export interface CreatedContract {
  id: number;
}

/** Result of creating an advertiser. */
export interface CreatedAdvertiser {
  id: number;
}

/** Result of creating a sandbox account. */
export interface CreatedAccount {
  accountID: number;
}

/** Result of creating a child account (carries fresh API credentials). */
export interface CreatedChildAccount {
  accountID: number;
  clientKey?: string;
  clientSecret?: string;
}

/** One statistics data point (a day, or the aggregate in `totalData`). */
export interface StatsData {
  timestamp?: string;
  views?: number;
  clicks?: number;
  ctr?: number;
  spend?: number;
  spendBonus?: number;
  cpm?: number;
  cpc?: number;
  videoViews25?: number;
  videoViews50?: number;
  videoViews75?: number;
  videoViews100?: number;
  q25?: number;
  q50?: number;
  q75?: number;
  vtr?: number;
}

/** Statistics for one entity (campaign, group or creative). */
export interface EntityStatistic {
  id?: number;
  name?: string;
  groupId?: number;
  paymentModel?: string;
  campaignType?: string;
  data?: StatsData[];
  totalData?: StatsData;
}

/** Campaign statistics, with the per-group and per-creative breakdowns. */
export interface CampaignStatisticResult {
  campaign?: EntityStatistic;
  groups?: EntityStatistic[];
  creatives?: EntityStatistic[];
}

// --- Request models ---

/** Payload for creating an advertiser. */
export interface AdvertiserInput {
  inn: string;
  shortName: string;
  longName: string;
  ogrn: string;
  legalAddress: string;
  actualAddress: string;
  legalRole: string;
  legalType: string;
  kpp?: string;
}

/** Payload for creating a sandbox (test) account. */
export interface SandboxAccountInput {
  inn: string;
  shortName: string;
  longName: string;
  ogrn: string;
  legalAddress: string;
  actualAddress: string;
  contact: Record<string, unknown>;
  kpp?: string;
  legalType?: string;
}

/**
 * Payload for creating a contract. Which fields are required depends on `type`
 * — the client validates the combination before the request goes out (see
 * `validateContractInput` in client.ts).
 */
export interface ContractInput {
  advertiserId: number;
  type: ContractType;
  /** Counterparty type; the API calls this field `description`. */
  description: ContractCounterpartyType;
  subject?: ContractSubject;
  /** Contract action; the API calls this field `object`. */
  object?: ContractAction;
  /** External contract id (only for, and required by, `type: "external"`). */
  cid?: string;
  /** Contract date, YYYY-MM-DD. */
  date?: string;
  /** Contract number. */
  number?: string;
  isReportingRequired?: boolean;
  isFundsAllocationToPrincipal?: boolean;
  /** Parent contract id; set it to register an additional agreement. */
  parentId?: number;
  /** Intermediary (contractor) details; required unless `parentId` is set. */
  intermediary?: Record<string, unknown>;
}

/** Inputs of a paginated list endpoint (all list endpoints are POST). */
export interface ListRequest {
  /** Endpoint-specific filter object, sent as-is. Defaults to `{}`. */
  filter?: Record<string, unknown>;
  /** Page size, 1..100. Defaults to 20; out-of-range values are clamped. */
  limit?: number;
  /** 1-based page number. Defaults to 1; out-of-range values are clamped. */
  page?: number;
}

/** One page of a list endpoint. */
export interface PaginatedResult<T> {
  /** Total number of items across all pages. */
  total: number;
  items: T[];
  page: number;
  limit: number;
  /** Whether another page exists after this one. */
  hasNextPage: boolean;
}

/**
 * Every client call returns the parsed body plus the weekly point quota left,
 * read off the `Api-Point-Balance` header. Avito meters this API in points that
 * refill Mondays 00:00 UTC, so tools pass the number through to the agent —
 * that is how it knows whether it can afford the next call.
 */
export interface ApiResponse<T> {
  data: T;
  /** Remaining weekly points, or null when the header was absent/unparseable. */
  apiPointBalance: number | null;
}

// --- Errors ---

/** Coarse failure class of an API error, derived from the HTTP status. */
export type AvitoErrorKind =
  | "bad_request"
  | "authentication"
  | "access_denied"
  | "not_found"
  | "rate_limit"
  | "server"
  | "api";

/** Maps an HTTP status onto the SDK's error taxonomy. */
export function errorKind(status: number): AvitoErrorKind {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "authentication";
    case 403:
      return "access_denied";
    case 404:
      return "not_found";
    case 429:
      return "rate_limit";
    default:
      return status >= 500 ? "server" : "api";
  }
}

/** What the failing response itself said about when to come back, and at what cost. */
export interface AvitoAdsErrorMeta {
  /**
   * `Retry-After` in seconds, exactly as the server sent it (uncapped — the cap
   * belongs to the client's sleep, not to what the agent is told).
   */
  retryAfter?: number;
  /** `Api-Point-Balance` of the failing response: the weekly quota left. */
  apiPointBalance?: number | null;
}

/**
 * A non-2xx response from the API (or from the token endpoint). The parsed body
 * is kept alongside the status; Avito's error bodies look like
 * `{ "code": "...", "message": "..." }`.
 *
 * A 429 is the error this weekly-metered API is built around, so it carries the
 * two numbers that make it actionable: `retryAfter` and `apiPointBalance`.
 */
export class AvitoAdsError extends Error {
  readonly status: number;
  readonly body?: unknown;
  /** Failure class, so callers can branch without matching on status numbers. */
  readonly kind: AvitoErrorKind;
  /** The API's own error code from the body, when it sent one. */
  readonly code?: string;
  /** Seconds to wait before repeating the call, when the server said so. */
  readonly retryAfter?: number;
  /** Weekly points left when the call failed, or null if the header was absent. */
  readonly apiPointBalance: number | null;

  constructor(status: number, body: unknown, context?: string, meta: AvitoAdsErrorMeta = {}) {
    super(`${context ? `${context}: ` : ""}HTTP ${status}: ${formatErrorBody(body)}`);
    this.name = "AvitoAdsError";
    this.status = status;
    this.body = body;
    this.kind = errorKind(status);
    const code = (body as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "string") this.code = code;
    if (typeof meta.retryAfter === "number") this.retryAfter = meta.retryAfter;
    this.apiPointBalance = meta.apiPointBalance ?? null;
  }
}

/**
 * Input rejected before it reached the network — a bad date range, a budget
 * below the minimum, an unknown role. Separate from {@link AvitoAdsError} so a
 * caller can tell "you sent nonsense" from "Avito said no".
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Turns a parsed API error body into a short, readable message. */
function formatErrorBody(body: unknown): string {
  if (body == null) return "(no body)";
  if (typeof body === "string") return body.slice(0, 500);
  if (typeof body !== "object") return String(body);
  const obj = body as Record<string, unknown>;

  // Avito style: { code, message } — sometimes wrapped as { error: { code, message } }.
  const inner = (obj.error && typeof obj.error === "object" ? obj.error : obj) as Record<string, unknown>;
  if (typeof inner.message === "string") {
    const code = inner.code !== undefined ? `[${String(inner.code)}] ` : "";
    return `${code}${inner.message}`.slice(0, 500);
  }

  return JSON.stringify(obj).slice(0, 500);
}
