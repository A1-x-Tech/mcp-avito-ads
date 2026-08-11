/**
 * Campaigns, ad groups and creatives — the ad objects themselves.
 *
 * The Avito Ads API exposes a deliberately narrow surface here: three paginated
 * list endpoints plus two writes on an ad group (its budget and its bid).
 * Campaigns, groups and creatives cannot be created, edited, paused, resumed,
 * archived or deleted through this API, and targeting is not exposed at all —
 * that work happens in the Avito Ads web cabinet. Every tool description says
 * so, so an agent does not go hunting for tools that do not exist.
 *
 * Filter fields mirror the official SDK's filter builders (CampaignsFilter,
 * GroupsFilter, CreativesFilter); the id-list keys are spelled with an
 * uppercase "ID" on the wire, which is the only translation this module does.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AvitoAdsClient } from "../client.js";
import {
  campaignStatusEnum,
  campaignTypeEnum,
  creativeStatusEnum,
  entityId,
  entityIds,
  fail,
  filterObject,
  groupStatusEnum,
  isoDate,
  ok,
  pageLimit,
  pageNumber,
  paymentModelEnum,
  READ_ONLY,
  rubleAmount,
  WRITE,
} from "./util.js";

/**
 * Normalized input name → the field name the API expects. Only the id lists
 * differ: the API spells them with an uppercase "ID" (`campaignIDs`), while
 * every other filter key already matches its input name.
 */
const WIRE_KEYS: Record<string, string> = {
  campaignIds: "campaignIDs",
  groupIds: "groupIDs",
  contractIds: "contractIDs",
  additionalAgreementIds: "additionalAgreementIDs",
};

/**
 * Builds the `filter` object a list endpoint takes from the tool's named
 * fields, renaming the id lists onto their wire spelling. `extra` is the
 * raw escape hatch, merged first so a named field always wins. Only
 * `undefined` is dropped — an explicit empty array is sent as given.
 */
function buildFilter(fields: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown> {
  const filter: Record<string, unknown> = { ...extra };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    filter[WIRE_KEYS[key] ?? key] = value;
  }
  return filter;
}

/*
 * Every schema below is a FACTORY, called once per field: sharing one zod
 * object between two fields of the same tool makes zod-to-json-schema collapse
 * them into a `$ref`, which some tool-schema consumers read as `any`.
 */

/** A list of entity ids used as a filter, with its own per-tool wording. */
const idList = (description: string) => entityIds().optional().describe(description);

/** An inclusive {from, to} date range filter, both ends YYYY-MM-DD. */
const dateRange = (description: string) =>
  z
    .object({
      from: isoDate().describe("Range start, YYYY-MM-DD."),
      to: isoDate().describe("Range end, YYYY-MM-DD."),
    })
    .optional()
    .describe(description);

const limitField = () => pageLimit().optional().describe("Page size, 1..100. Default 20.");

const pageField = () => pageNumber().optional().describe("1-based page number. Default 1.");

const paymentModelsField = () =>
  z.array(paymentModelEnum()).optional().describe("Payment models to keep: CPM, CPC.");

const campaignTypesField = () =>
  z.array(campaignTypeEnum()).optional().describe("Campaign types to keep: textImage, HTML, video.");

const rawFilter = () =>
  filterObject()
    .optional()
    .describe(
      "Escape hatch: extra filter keys merged as-is into the request filter (API spelling). The named fields above win on conflict.",
    );

export function registerCatalogTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "list_campaigns",
    {
      title: "List ad campaigns",
      annotations: READ_ONLY,
      description:
        "Lists the account's ad campaigns, one page at a time. Returns {total, items, page, limit, hasNextPage} plus apiPointBalance — the weekly API points left, which refill Mondays 00:00 UTC. Each campaign carries id, name, status, budget (rubles), paymentModel (CPM/CPC), campaignType, startDate/endDate, advertiserId, contractId, managerID and timestamps. All filter fields are AND-ed and each list keeps only the values it names. This API cannot create, edit, pause, resume, archive or delete a campaign and cannot touch its targeting — the only writes available anywhere are change_group_budget and change_group_price on an ad group.",
      inputSchema: {
        ids: idList("Campaign ids to keep."),
        statuses: z
          .array(campaignStatusEnum())
          .optional()
          .describe(
            "Campaign statuses to keep: draft, in_moderation, moderation_failed, partial_moderation, active, paused, stopped, finished, archived.",
          ),
        campaignTypes: campaignTypesField(),
        paymentModels: paymentModelsField(),
        advertisers: idList("Advertiser ids whose campaigns to keep."),
        managers: idList("Manager (account user) ids whose campaigns to keep."),
        contractIds: idList("Contract ids whose campaigns to keep."),
        additionalAgreementIds: idList("Additional-agreement ids whose campaigns to keep."),
        createdAt: dateRange("Keep campaigns created in this range: {from, to}, YYYY-MM-DD."),
        timeFrame: dateRange("Keep campaigns whose flight window falls in this range: {from, to}, YYYY-MM-DD."),
        filter: rawFilter(),
        limit: limitField(),
        page: pageField(),
      },
    },
    async ({ limit, page, filter, ...fields }) => {
      try {
        return ok(await client.listCampaigns({ filter: buildFilter(fields, filter), limit, page }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_groups",
    {
      title: "List ad groups",
      annotations: READ_ONLY,
      description:
        "Lists the account's ad groups, one page at a time. Returns {total, items, page, limit, hasNextPage} plus apiPointBalance (weekly API points left). The group is the level that holds the money: each item carries id, name, campaignID, status, budget and price (the bid) in rubles, paymentModel, campaignType, advertiserID, haveCreative and timestamps. Use change_group_budget / change_group_price to change those two numbers — they are the only writable fields in the whole ad object tree. Groups cannot be created, renamed, paused, resumed or deleted here, and their targeting is not exposed.",
      inputSchema: {
        ids: idList("Ad group ids to keep."),
        campaignIds: idList("Campaign ids whose groups to keep."),
        statuses: z
          .array(groupStatusEnum())
          .optional()
          .describe(
            "Group statuses to keep: draft, in_moderation, moderation_failed, will_launch_soon, active, will_stop_soon, pausing, paused, unpausing, stopped, finished, archived.",
          ),
        paymentModels: paymentModelsField(),
        paces: z
          .array(z.string().min(1))
          .optional()
          .describe("Budget pacing modes to keep. Free-form: the SDK documents no fixed vocabulary for this filter."),
        advertisers: idList("Advertiser ids whose groups to keep."),
        managers: idList("Manager (account user) ids whose groups to keep."),
        timeFrame: dateRange("Keep groups whose flight window falls in this range: {from, to}, YYYY-MM-DD."),
        filter: rawFilter(),
        limit: limitField(),
        page: pageField(),
      },
    },
    async ({ limit, page, filter, ...fields }) => {
      try {
        return ok(await client.listGroups({ filter: buildFilter(fields, filter), limit, page }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_creatives",
    {
      title: "List creatives",
      annotations: READ_ONLY,
      description:
        "Lists the account's creatives — the ads themselves — one page at a time. Returns {total, items, page, limit, hasNextPage} plus apiPointBalance (weekly API points left). Each creative carries id, name, title, description, buttonText, link, status, groupID, campaignID, advertiserID, paymentModel, campaignType and legalInfo (the ad-registry/ERID data). Read-only: creatives cannot be uploaded, edited, sent to moderation, paused or deleted through this API — only ad-group budget and bid are writable.",
      inputSchema: {
        ids: idList("Creative ids to keep."),
        groupIds: idList("Ad group ids whose creatives to keep."),
        campaignIds: idList("Campaign ids whose creatives to keep."),
        statuses: z
          .array(creativeStatusEnum())
          .optional()
          .describe(
            "Creative statuses to keep: draft, ready_for_moderation, in_moderation, moderation_failed, erir_registration, active, paused, stopped, finished, archived.",
          ),
        campaignTypes: campaignTypesField(),
        paymentModels: paymentModelsField(),
        advertisers: idList("Advertiser ids whose creatives to keep."),
        managers: idList("Manager (account user) ids whose creatives to keep."),
        timeFrame: dateRange("Keep creatives whose flight window falls in this range: {from, to}, YYYY-MM-DD."),
        filter: rawFilter(),
        limit: limitField(),
        page: pageField(),
      },
    },
    async ({ limit, page, filter, ...fields }) => {
      try {
        return ok(await client.listCreatives({ filter: buildFilter(fields, filter), limit, page }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "change_group_budget",
    {
      title: "Change ad group budget",
      annotations: WRITE,
      description:
        "Sets one ad group's budget to the given amount in rubles (at least 1). The value replaces the current budget rather than adding to it, so repeating the call is safe. Only groups on manual bid management accept it; the API rejects the rest. Returns the API's acknowledgement plus apiPointBalance. It cannot change the campaign budget, the bid (use change_group_price), or the group's status — this API cannot pause, resume or delete a group at all. Read the current budget with list_groups first.",
      inputSchema: {
        groupId: entityId().describe("Id of the ad group to change, from list_groups."),
        budget: rubleAmount().describe("New budget in rubles, at least 1. Replaces the current value."),
      },
    },
    async ({ groupId, budget }) => {
      try {
        return ok(await client.changeGroupBudget({ groupId, budget }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "change_group_price",
    {
      title: "Change ad group bid",
      annotations: WRITE,
      description:
        "Sets one ad group's bid (the API calls it price) to the given amount in rubles (at least 1). The unit follows the group's paymentModel: rubles per 1000 impressions for CPM, rubles per click for CPC. The value replaces the current bid rather than adding to it, so repeating the call is safe. Only groups on manual bid management accept it. Returns the API's acknowledgement plus apiPointBalance. It cannot change the budget (use change_group_budget) or the group's status — this API cannot pause, resume or delete a group at all. Read the current bid from the price field of list_groups.",
      inputSchema: {
        groupId: entityId().describe("Id of the ad group to change, from list_groups."),
        price: rubleAmount().describe("New bid in rubles, at least 1. Replaces the current value."),
      },
    },
    async ({ groupId, price }) => {
      try {
        return ok(await client.changeGroupPrice({ groupId, price }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
