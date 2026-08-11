import type {
  Account,
  Advertiser,
  AdvertiserInput,
  ApiResponse,
  AvitoAdsConfig,
  Balance,
  Campaign,
  CampaignStatisticResult,
  ChildAccount,
  Contract,
  ContractInput,
  CreatedAccount,
  CreatedAdvertiser,
  CreatedChildAccount,
  CreatedContract,
  Creative,
  EntityStatistic,
  Group,
  ListRequest,
  PaginatedResult,
  SandboxAccountInput,
  User,
  UserRole,
} from "./types.js";
import { AvitoAdsError, USER_ROLES, ValidationError } from "./types.js";

export type HttpMethod = "GET" | "POST" | "DELETE";

/** Page size bounds of every list endpoint. */
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;

/** Longest statistics period the API accepts, in days (inclusive of both ends). */
export const MAX_STATS_PERIOD_DAYS = 100;

/** Smallest budget / bid / transfer the API accepts, in rubles (or bonus rubles). */
const MIN_AMOUNT = 1;

/**
 * Identifies the server to Avito when no version is known (tests, `npm run
 * smoke`); index.ts passes `mcp-avito-ads/<package version>` instead.
 */
export const DEFAULT_USER_AGENT = "mcp-avito-ads";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Statistics period, shared by the three stats endpoints. */
export interface StatsPeriod {
  campaignId: number;
  /** Period start, YYYY-MM-DD. */
  dateFrom: string;
  /** Period end, YYYY-MM-DD; at most 100 days after dateFrom. */
  dateTo: string;
}

export interface GroupStatsParams extends StatsPeriod {
  /**
   * Groups to report on. Required, as in the official SDK: what the API does
   * with an empty list is not documented anywhere, so the caller says which
   * groups it means (`campaign_stats` is the way to get all of them).
   */
  groupIds: number[];
}

export interface CreativeStatsParams extends StatsPeriod {
  /** Creatives to report on. Required, for the same reason as `groupIds`. */
  creativeIds: number[];
}

/**
 * Clamps and defaults the `filter`/`limit`/`page` triple every list endpoint
 * takes. Out-of-range values are clamped rather than rejected: an agent that
 * asks for 500 rows wants "as many as possible", and a hard error would just
 * burn another API point on the retry.
 */
export function normalizeListRequest(req: ListRequest = {}): Required<ListRequest> {
  return {
    filter: req.filter ?? {},
    limit: clamp(req.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT),
    page: clamp(req.page, 1, 1, Number.MAX_SAFE_INTEGER),
  };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * `Retry-After` in seconds as the server sent it, or undefined when the header
 * is absent or not a count of seconds. Not capped: the cap belongs to the sleep
 * below, while the error surfaced to the agent must carry the real number.
 */
export function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get("Retry-After");
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Backoff before a retry: honors Retry-After when the server sent one (capped
 * at 30s so a hostile header cannot park the process), else exponential.
 * Exported so the schedule can be tested without waiting for it.
 */
export function backoffMs(attempt: number, retryBaseMs: number, res?: Response): number {
  const retryAfter = res ? retryAfterSeconds(res) : undefined;
  if (retryAfter !== undefined) return Math.min(retryAfter, 30) * 1000;
  return Math.min(retryBaseMs * 2 ** attempt, 30_000);
}

/**
 * Validates a contract payload against the API's per-type rules, which are
 * otherwise only discoverable as a 400:
 *  - service      — needs subject, isReportingRequired, date, number; cid is rejected
 *  - intermediary — the above plus object and isFundsAllocationToPrincipal; cid is rejected
 *  - external     — needs cid; parentId is rejected; date/number are optional
 * `intermediary` (the contractor's details) is required unless `parentId` is
 * set, and forbidden when it is — a child record is an additional agreement.
 */
export function validateContractInput(input: ContractInput): void {
  const require = (key: keyof ContractInput, message: string): void => {
    if (input[key] === undefined || input[key] === null) throw new ValidationError(message);
  };
  require("advertiserId", "advertiserId is required.");
  require("type", "type is required.");
  require("description", "description (counterparty type) is required.");

  const hasParent = input.parentId !== undefined;
  const hasIntermediary = input.intermediary !== undefined;

  if (input.type === "external") {
    require("cid", 'A contract of type "external" requires cid.');
    if (hasParent) throw new ValidationError('A contract of type "external" cannot carry parentId.');
  }

  if (input.type === "service" || input.type === "intermediary") {
    for (const key of ["subject", "isReportingRequired", "date", "number"] as const) {
      require(key, `A contract of type "${input.type}" requires subject, isReportingRequired, date and number.`);
    }
    if (input.cid !== undefined) throw new ValidationError(`A contract of type "${input.type}" cannot carry cid.`);
  }

  if (input.type === "intermediary") {
    require("object", 'A contract of type "intermediary" requires object.');
    require("isFundsAllocationToPrincipal", 'A contract of type "intermediary" requires isFundsAllocationToPrincipal.');
  }

  if (input.date !== undefined && !DATE_RE.test(input.date)) {
    throw new ValidationError("date must be in YYYY-MM-DD format.");
  }
  if (hasParent && hasIntermediary) {
    throw new ValidationError("An additional agreement (parentId is set) cannot carry intermediary details.");
  }
  if (!hasParent && !hasIntermediary) {
    throw new ValidationError("intermediary (contractor details) is required unless parentId is set.");
  }
}

/**
 * Client for the Avito Ads API.
 *
 * One instance owns the OAuth2 token (cached in memory, refreshed early) and
 * every request goes through {@link request}: SSRF-guarded path resolution,
 * an AbortController timeout that also covers reading the body, retries with
 * backoff, and the `Api-Point-Balance` header lifted out of every response.
 *
 * Retries are deliberately asymmetric. 429 is always safe to repeat — the
 * request was refused, not performed — but a 5xx or a dropped connection on a
 * write (a funds transfer!) may well have committed, so only reads repeat those.
 */
export class AvitoAdsClient {
  private readonly base: string;
  private readonly basePath: string;
  private readonly tokenEndpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly leewayMs: number;
  private readonly userAgent: string;

  private token?: { value: string; expiresAt: number };
  /** In-flight token request, so parallel tool calls mint exactly one token. */
  private tokenRequest?: Promise<string>;

  constructor(
    private readonly config: AvitoAdsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = config.apiBase.endsWith("/") ? config.apiBase : config.apiBase + "/";
    const baseUrl = new URL(this.base);
    this.basePath = baseUrl.pathname;
    // The token endpoint sits at the host root, next to (not under) the API
    // prefix; deriving it from the base keeps a mock server self-consistent.
    this.tokenEndpoint = new URL("/token", baseUrl).toString();
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 4;
    this.retryBaseMs = config.retryBaseMs ?? 500;
    this.leewayMs = (config.tokenLeewaySeconds ?? 60) * 1000;
    // Node's fetch would otherwise send `User-Agent: node`, which is
    // indistinguishable from any other script in Avito's logs.
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  }

  /** The ad account every path is scoped to (from config, never from a tool). */
  get accountId(): number {
    return this.config.accountId;
  }

  /** Which environment this client talks to. */
  get environment(): string {
    return this.config.environment;
  }

  /** Builds an account-scoped path, e.g. accountPath("balance"). */
  accountPath(suffix = ""): string {
    const base = `v1/account/${this.config.accountId}`;
    return suffix ? `${base}/${suffix}` : base;
  }

  // --- Auth ---

  /**
   * A valid access token, minted on demand and cached until `leeway` before it
   * expires. Concurrent callers share one in-flight request; a failed request
   * is not cached.
   */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - this.leewayMs) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchToken().finally(() => {
        this.tokenRequest = undefined;
      });
    }
    return this.tokenRequest;
  }

  /** Drops the cached token so the next call mints a fresh one (used on 401). */
  private forgetToken(): void {
    this.token = undefined;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    }).toString();

    const { res, text } = await this.fetchWithTimeout(
      this.tokenEndpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
        body,
      },
      "token",
    );

    const data = parseBody(text);
    if (!res.ok) {
      throw new AvitoAdsError(res.status, data, "OAuth2 token request failed", {
        retryAfter: retryAfterSeconds(res),
      });
    }

    const parsed = (data ?? {}) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== "string" || !parsed.access_token) {
      throw new AvitoAdsError(res.status, data, "OAuth2 token response carried no access_token");
    }
    const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 86_400;
    this.token = { value: parsed.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return parsed.access_token;
  }

  // --- Transport ---

  /**
   * fetch with an AbortController timeout. Reads the response body inside the
   * guarded zone so the timeout also covers a slow or drip-feeding body, not just
   * the initial headers, and returns the text alongside the response.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request to "${label}" timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Low-level request to an API path (e.g. "v1/account/123/campaigns"), used by
   * every method here and by the raw_request tool. Reads (GET) are retried on
   * 5xx and network failures; writes are not, because a repeated POST could
   * double-charge. Non-2xx throws {@link AvitoAdsError}.
   */
  async request<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.send<T>(method, path, body, method === "GET");
  }

  private async send<T>(
    method: HttpMethod,
    path: string,
    body: unknown,
    retryUnsafe: boolean,
  ): Promise<ApiResponse<T>> {
    const target = this.resolve(path);
    const payload = body === undefined ? undefined : JSON.stringify(body);

    let attempt = 0;
    let tokenRefreshed = false;

    for (;;) {
      const token = await this.getToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": this.userAgent,
      };
      if (payload !== undefined) headers["Content-Type"] = "application/json";

      let res: Response;
      let text: string;
      try {
        ({ res, text } = await this.fetchWithTimeout(target, { method, headers, body: payload }, path));
      } catch (err) {
        // Network error or timeout: the request may or may not have been
        // applied, so only reads repeat it.
        if (retryUnsafe && attempt < this.maxRetries) {
          attempt++;
          await delay(backoffMs(attempt - 1, this.retryBaseMs));
          continue;
        }
        throw err;
      }

      // 401: the token expired earlier than advertised (or was revoked). Refresh
      // once and repeat — this does not consume a retry, and a second 401 falls
      // through to the error below instead of looping.
      if (res.status === 401 && !tokenRefreshed) {
        tokenRefreshed = true;
        this.forgetToken();
        continue;
      }

      // 429 means the call was refused outright, so repeating it is safe even
      // for writes; 5xx is only safe to repeat for reads.
      const transient = res.status === 429 || (retryUnsafe && res.status >= 500 && res.status < 600);
      if (transient && attempt < this.maxRetries) {
        attempt++;
        await delay(backoffMs(attempt - 1, this.retryBaseMs, res));
        continue;
      }

      const data = parseBody(text);
      // The failing response is the one moment the quota matters most, so the
      // error carries both numbers it came with: when to come back (Retry-After,
      // uncapped) and how much of the weekly budget is left.
      if (!res.ok) {
        throw new AvitoAdsError(res.status, data, undefined, {
          retryAfter: retryAfterSeconds(res),
          apiPointBalance: pointBalance(res),
        });
      }
      return { data: (data ?? {}) as T, apiPointBalance: pointBalance(res) };
    }
  }

  /**
   * Resolves a caller-supplied path against the API base and rejects anything
   * that escaped it — an absolute "https://evil/x", a "\\evil/x", or a "../token"
   * climbing out of /ads/ — so the Bearer token can never be handed to another
   * host or replayed against the credential endpoint.
   *
   * It also holds the server's central invariant for `raw_request`, the one
   * caller that supplies its own path: the account id is config, never an
   * argument. Every Avito Ads endpoint is `v1/account/{accountID}/...`, so a
   * path naming a different account (`v1/account/999/funds-transfer`) is
   * refused. The check runs on the *resolved, decoded* path, which is why
   * `v1/account/777/../../account/999/x` cannot slip past it.
   */
  private resolve(path: string): string {
    const url = new URL(path.replace(/^\/+/, ""), this.base);
    const baseOrigin = new URL(this.base).origin;
    if (url.origin !== baseOrigin) {
      throw new Error(`API path must be relative (resolved to foreign origin ${url.origin})`);
    }
    if (!url.pathname.startsWith(this.basePath)) {
      throw new Error(`API path must stay under ${this.basePath} (resolved to ${url.pathname})`);
    }
    const account = accountSegment(url.pathname.slice(this.basePath.length));
    if (account !== undefined && account !== String(this.config.accountId)) {
      throw new Error(
        `API path must address the configured account ${this.config.accountId} (got ${account}); ` +
          "the account id comes from AVITO_ADS_ACCOUNT_ID and cannot be chosen per call",
      );
    }
    return url.toString();
  }

  /** POSTs a list endpoint and reshapes the response into one page of items. */
  private async listResource<T>(
    path: string,
    itemsKey: string,
    req: ListRequest = {},
  ): Promise<ApiResponse<PaginatedResult<T>>> {
    const { filter, limit, page } = normalizeListRequest(req);
    const res = await this.send<Record<string, unknown>>("POST", path, { filter, limit, page }, true);
    const total = typeof res.data.total === "number" ? res.data.total : 0;
    const raw = res.data[itemsKey];
    const items = Array.isArray(raw) ? (raw as T[]) : [];
    return {
      data: { total, items, page, limit, hasNextPage: page * limit < total },
      apiPointBalance: res.apiPointBalance,
    };
  }

  // --- Account ---

  /** Legal details of the configured account. GET v1/account/{accountID}. */
  async getAccount(): Promise<ApiResponse<Account>> {
    const res = await this.send<{ account?: Account } & Account>("GET", this.accountPath(), undefined, true);
    // The API answers either {"account": {...}} or a flat object.
    return { data: res.data.account ?? res.data, apiPointBalance: res.apiPointBalance };
  }

  /** Money and bonus balance. GET v1/account/{accountID}/balance. */
  getBalance(): Promise<ApiResponse<Balance>> {
    return this.send<Balance>("GET", this.accountPath("balance"), undefined, true);
  }

  /**
   * Creates a test account. Sandbox only. POST v1/account/{accountID}.
   *
   * (Every validating method here is `async` so a rejected input arrives as a
   * rejected promise, never as a synchronous throw the caller's `.catch` misses.)
   */
  async createSandboxAccount(input: SandboxAccountInput): Promise<ApiResponse<CreatedAccount>> {
    if (!input.contact || Object.keys(input.contact).length === 0) {
      throw new ValidationError("contact is required when creating an account.");
    }
    return this.send<CreatedAccount>("POST", this.accountPath(), compact(input), false);
  }

  // --- Child accounts and money movement ---

  /** Child accounts. GET v1/account/{accountID}/children. */
  async listChildAccounts(): Promise<ApiResponse<ChildAccount[]>> {
    const res = await this.send<{ children?: ChildAccount[] }>("GET", this.accountPath("children"), undefined, true);
    return { data: res.data.children ?? [], apiPointBalance: res.apiPointBalance };
  }

  /** Child accounts with their balances. GET v1/account/{accountID}/children-with-balances. */
  async listChildAccountsWithBalances(): Promise<ApiResponse<ChildAccount[]>> {
    const res = await this.send<{ children?: ChildAccount[] }>(
      "GET",
      this.accountPath("children-with-balances"),
      undefined,
      true,
    );
    return { data: res.data.children ?? [], apiPointBalance: res.apiPointBalance };
  }

  /**
   * Creates a non-payer child account and returns its fresh API credentials.
   * POST v1/account/{accountID}/create-nonpayer-child-account.
   */
  async createNonpayerChildAccount(params: {
    shortName: string;
    isSelfAdvertisingEnabled: boolean;
  }): Promise<ApiResponse<CreatedChildAccount>> {
    if (!params.shortName) throw new ValidationError("shortName is required.");
    return this.send<CreatedChildAccount>(
      "POST",
      this.accountPath("create-nonpayer-child-account"),
      { shortName: params.shortName, isSelfAdvertisingEnabled: params.isSelfAdvertisingEnabled },
      false,
    );
  }

  /**
   * Moves rubles to another account. POST v1/account/{accountID}/funds-transfer.
   * Real money — never retried, and the amount must be at least 1.
   */
  async transferFunds(params: { accountIdTo: number; amount: number }): Promise<ApiResponse<unknown>> {
    assertAmount(params.amount, "amount");
    return this.send("POST", this.accountPath("funds-transfer"), {
      accountIdTo: params.accountIdTo,
      amount: params.amount,
    }, false);
  }

  /** Moves bonus rubles to another account. POST v1/account/{accountID}/bonus-transfer. */
  async transferBonus(params: { accountIdTo: number; amount: number }): Promise<ApiResponse<unknown>> {
    assertAmount(params.amount, "amount");
    return this.send("POST", this.accountPath("bonus-transfer"), {
      accountIdTo: params.accountIdTo,
      amount: params.amount,
    }, false);
  }

  // --- Advertisers ---

  /** Registers an advertiser. POST v1/account/{accountID}/create-advertiser. */
  createAdvertiser(input: AdvertiserInput): Promise<ApiResponse<CreatedAdvertiser>> {
    return this.send<CreatedAdvertiser>("POST", this.accountPath("create-advertiser"), compact(input), false);
  }

  /** Advertisers, paginated. POST v1/account/{accountID}/advertisers. */
  listAdvertisers(req: ListRequest = {}): Promise<ApiResponse<PaginatedResult<Advertiser>>> {
    return this.listResource<Advertiser>(this.accountPath("advertisers"), "advertisers", req);
  }

  // --- Contracts ---

  /** Registers a contract. POST v1/account/{accountID}/create-contract. */
  async createContract(input: ContractInput): Promise<ApiResponse<CreatedContract>> {
    validateContractInput(input);
    return this.send<CreatedContract>("POST", this.accountPath("create-contract"), compact(input), false);
  }

  /** Contracts, paginated. POST v1/account/{accountID}/contracts. */
  listContracts(req: ListRequest = {}): Promise<ApiResponse<PaginatedResult<Contract>>> {
    return this.listResource<Contract>(this.accountPath("contracts"), "contracts", req);
  }

  // --- Campaigns, groups, creatives ---

  /** Campaigns, paginated. POST v1/account/{accountID}/campaigns. */
  listCampaigns(req: ListRequest = {}): Promise<ApiResponse<PaginatedResult<Campaign>>> {
    return this.listResource<Campaign>(this.accountPath("campaigns"), "campaigns", req);
  }

  /** Ad groups, paginated. POST v1/account/{accountID}/groups. */
  listGroups(req: ListRequest = {}): Promise<ApiResponse<PaginatedResult<Group>>> {
    return this.listResource<Group>(this.accountPath("groups"), "groups", req);
  }

  /**
   * Sets a group's budget (manual bidding only; at least 1 ruble).
   * POST v1/account/{accountID}/group/{groupID}/change-budget.
   */
  async changeGroupBudget(params: { groupId: number; budget: number }): Promise<ApiResponse<unknown>> {
    assertAmount(params.budget, "budget");
    return this.send("POST", this.accountPath(`group/${params.groupId}/change-budget`), { budget: params.budget }, false);
  }

  /**
   * Sets a group's bid (manual bidding only; at least 1 ruble).
   * POST v1/account/{accountID}/group/{groupID}/change-price.
   */
  async changeGroupPrice(params: { groupId: number; price: number }): Promise<ApiResponse<unknown>> {
    assertAmount(params.price, "price");
    return this.send("POST", this.accountPath(`group/${params.groupId}/change-price`), { price: params.price }, false);
  }

  /** Creatives, paginated. POST v1/account/{accountID}/creatives. */
  listCreatives(req: ListRequest = {}): Promise<ApiResponse<PaginatedResult<Creative>>> {
    return this.listResource<Creative>(this.accountPath("creatives"), "creatives", req);
  }

  // --- Statistics ---

  /**
   * Campaign statistics with the per-group and per-creative breakdowns.
   * POST v1/account/{accountID}/campaigns/{campaignID}/stats.
   */
  async campaignStats(params: StatsPeriod): Promise<ApiResponse<CampaignStatisticResult>> {
    assertPeriod(params.dateFrom, params.dateTo);
    return this.send<CampaignStatisticResult>(
      "POST",
      this.accountPath(`campaigns/${params.campaignId}/stats`),
      { dateFrom: params.dateFrom, dateTo: params.dateTo },
      true,
    );
  }

  /** Per-group statistics. POST v1/account/{accountID}/campaigns/{campaignID}/groups/stats. */
  async groupStats(params: GroupStatsParams): Promise<ApiResponse<EntityStatistic[]>> {
    assertPeriod(params.dateFrom, params.dateTo);
    const res = await this.send<{ groups?: EntityStatistic[] }>(
      "POST",
      this.accountPath(`campaigns/${params.campaignId}/groups/stats`),
      { dateFrom: params.dateFrom, dateTo: params.dateTo, groupIDs: params.groupIds },
      true,
    );
    return { data: res.data.groups ?? [], apiPointBalance: res.apiPointBalance };
  }

  /** Per-creative statistics. POST v1/account/{accountID}/campaigns/{campaignID}/creatives/stats. */
  async creativeStats(params: CreativeStatsParams): Promise<ApiResponse<EntityStatistic[]>> {
    assertPeriod(params.dateFrom, params.dateTo);
    const res = await this.send<{ creatives?: EntityStatistic[] }>(
      "POST",
      this.accountPath(`campaigns/${params.campaignId}/creatives/stats`),
      { dateFrom: params.dateFrom, dateTo: params.dateTo, creativeIDs: params.creativeIds },
      true,
    );
    return { data: res.data.creatives ?? [], apiPointBalance: res.apiPointBalance };
  }

  // --- Users ---

  /** Users with access to the account. GET v1/account/{accountID}/users. */
  async listUsers(): Promise<ApiResponse<User[]>> {
    const res = await this.send<{ users?: User[] }>("GET", this.accountPath("users"), undefined, true);
    return { data: res.data.users ?? [], apiPointBalance: res.apiPointBalance };
  }

  /** Grants a user access. POST v1/account/{accountID}/add-user. */
  async addUser(params: { userId: number; role: UserRole }): Promise<ApiResponse<unknown>> {
    const role = assertRole(params.role);
    return this.send("POST", this.accountPath("add-user"), { userId: params.userId, role }, false);
  }

  /** Changes a user's role. POST v1/account/{accountID}/set-user-role. */
  async setUserRole(params: { userId: number; role: UserRole }): Promise<ApiResponse<unknown>> {
    const role = assertRole(params.role);
    return this.send("POST", this.accountPath("set-user-role"), { userId: params.userId, role }, false);
  }

  /** Revokes a user's access. DELETE v1/account/{accountID}/delete-user/{userID}. */
  deleteUser(userId: number): Promise<ApiResponse<unknown>> {
    return this.send("DELETE", this.accountPath(`delete-user/${userId}`), undefined, false);
  }
}

/** Rejects budgets, bids and transfers below the API's minimum of 1. */
function assertAmount(value: number, field: string): void {
  if (!Number.isFinite(value) || value < MIN_AMOUNT) {
    throw new ValidationError(`${field} must be at least ${MIN_AMOUNT}, got ${value}.`);
  }
}

function assertRole(role: string): UserRole {
  if ((USER_ROLES as readonly string[]).includes(role)) return role as UserRole;
  throw new ValidationError(`role must be one of ${USER_ROLES.join(", ")}, got "${role}".`);
}

/**
 * Parses a YYYY-MM-DD date to epoch ms, or NaN if it is not a real calendar
 * date. The round-trip is what catches 2026-02-31: Date.parse silently rolls
 * that over to March 3 instead of failing.
 */
function parseIsoDate(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return Number.NaN;
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/** Checks the date format and the 100-day cap before spending an API point. */
function assertPeriod(dateFrom: string, dateTo: string): void {
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
    throw new ValidationError("dateFrom and dateTo must be in YYYY-MM-DD format.");
  }
  const from = parseIsoDate(dateFrom);
  const to = parseIsoDate(dateTo);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new ValidationError("dateFrom and dateTo must be real calendar dates.");
  }
  if (from > to) throw new ValidationError("dateFrom must not be later than dateTo.");
  const days = Math.round((to - from) / 86_400_000) + 1;
  if (days > MAX_STATS_PERIOD_DAYS) {
    throw new ValidationError(
      `The statistics period must not exceed ${MAX_STATS_PERIOD_DAYS} days, got ${days}.`,
    );
  }
}

/**
 * The account id an API path addresses, or undefined when the path is not
 * account-scoped. Percent-encoding is decoded first, so `v1/account/%399/x`
 * cannot hide an account id from the caller-side check.
 */
function accountSegment(pathAfterBase: string): string | undefined {
  let rest = pathAfterBase;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Malformed escapes: check the raw form rather than giving up on the guard.
  }
  return /^v\d+\/account\/([^/]+)(?:\/|$)/i.exec(rest)?.[1];
}

/** Remaining weekly point quota, or null when the header is missing/garbage. */
function pointBalance(res: Response): number | null {
  const raw = res.headers.get("Api-Point-Balance");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Parses a response body, degrading to the raw text (or undefined when empty). */
function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Drops keys whose value is `undefined` so they are not sent to the API. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
