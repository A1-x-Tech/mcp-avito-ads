import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AvitoAdsClient } from "../client.js";
import { MAX_STATS_PERIOD_DAYS } from "../client.js";
import { entityId, entityIds, fail, isoDate, ok, READ_ONLY } from "./util.js";

/**
 * Reporting tools. All three are POST endpoints scoped to a single campaign of
 * the configured account, all take an inclusive YYYY-MM-DD period, and all are
 * read-only.
 *
 * The period rules (format, dateFrom <= dateTo, at most MAX_STATS_PERIOD_DAYS,
 * real calendar dates) are enforced by the client's `assertPeriod` before the
 * request goes
 * out — the same rules the official SDK applies in resources/statistics.ts — so
 * a bad range costs no API point. zod checks the shape here; the cross-field
 * part cannot live in a tool `inputSchema` (it is a flat shape, not a
 * refinable object), so it is not duplicated.
 *
 * Metric vocabulary of every row (`data[]` per day, `totalData` for the whole
 * period): views (impressions), clicks, ctr, spend, spendBonus, cpm, cpc and,
 * for video campaigns, videoViews25/50/75/100, q25/q50/q75, vtr. Money is in
 * rubles; rates come through exactly as the API reports them.
 */

/** Shared tail of every description: the metering the agent has to pace itself against. */
const POINTS_NOTE =
  "Costs weekly API points; the reply's apiPointBalance is what is left until the quota refills Monday 00:00 UTC, so prefer one wide period over many narrow calls.";

/** The period rule, taken from the client's cap so the text cannot drift from the check. */
const PERIOD_NOTE = `The period is inclusive, YYYY-MM-DD, and must span at most ${MAX_STATS_PERIOD_DAYS} days. `;

const DATE_FROM_NOTE = "First day of the period, inclusive (YYYY-MM-DD).";
const DATE_TO_NOTE = `Last day of the period, inclusive (YYYY-MM-DD). Must be >= dateFrom, and the period must not exceed ${MAX_STATS_PERIOD_DAYS} days.`;

export function registerStatisticsTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "campaign_stats",
    {
      title: "Campaign statistics",
      annotations: READ_ONLY,
      description:
        "Statistics for ONE campaign over a date range, with its per-group and per-creative breakdowns: {campaign, groups[], creatives[]}. Every entity carries data[] (one row per day, stamped with timestamp) and totalData (the period aggregate). Metrics per row: views (impressions), clicks, ctr, spend, spendBonus, cpm, cpc, plus videoViews25/50/75/100, q25/q50/q75 and vtr for video campaigns; money is in rubles, rates pass through unchanged. " +
        PERIOD_NOTE +
        "Cannot aggregate across campaigns and has no sub-day granularity; get campaignId from list_campaigns. " +
        POINTS_NOTE,
      inputSchema: {
        campaignId: entityId().describe("Campaign to report on. Find ids with list_campaigns."),
        dateFrom: isoDate().describe(DATE_FROM_NOTE),
        dateTo: isoDate().describe(DATE_TO_NOTE),
      },
    },
    async ({ campaignId, dateFrom, dateTo }) => {
      try {
        return ok(await client.campaignStats({ campaignId, dateFrom, dateTo }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "group_stats",
    {
      title: "Ad group statistics",
      annotations: READ_ONLY,
      description:
        "Per-group statistics for the groups you name in one campaign: a flat array with one entry per ad group ({id, name, paymentModel, campaignType, data[] per day, totalData for the period}). Same metrics as campaign_stats — views (impressions), clicks, ctr, spend, spendBonus, cpm, cpc, video quartiles, vtr — with money in rubles. groupIds is required: this tool narrows, it does not enumerate. " +
        PERIOD_NOTE +
        "Returns no campaign-level totals; for every group of a campaign call campaign_stats, which carries the same breakdown. " +
        POINTS_NOTE,
      inputSchema: {
        campaignId: entityId().describe("Campaign whose groups are reported. Find ids with list_campaigns."),
        dateFrom: isoDate().describe(DATE_FROM_NOTE),
        dateTo: isoDate().describe(DATE_TO_NOTE),
        groupIds: entityIds().describe(
          "Ad group ids to report on, e.g. [101, 102]. Required; get them from list_groups, or use campaign_stats for the whole campaign.",
        ),
      },
    },
    async ({ campaignId, dateFrom, dateTo, groupIds }) => {
      try {
        return ok(await client.groupStats({ campaignId, dateFrom, dateTo, groupIds }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "creative_stats",
    {
      title: "Creative statistics",
      annotations: READ_ONLY,
      description:
        "Per-creative statistics for the creatives you name in one campaign: a flat array with one entry per creative ({id, name, groupId, paymentModel, campaignType, data[] per day, totalData for the period}). Same metrics as campaign_stats — views (impressions), clicks, ctr, spend, spendBonus, cpm, cpc, video quartiles, vtr — with money in rubles. creativeIds is required: this tool narrows, it does not enumerate. " +
        PERIOD_NOTE +
        "Returns no campaign-level totals; for every creative of a campaign call campaign_stats, which carries the same breakdown. " +
        POINTS_NOTE,
      inputSchema: {
        campaignId: entityId().describe("Campaign whose creatives are reported. Find ids with list_campaigns."),
        dateFrom: isoDate().describe(DATE_FROM_NOTE),
        dateTo: isoDate().describe(DATE_TO_NOTE),
        creativeIds: entityIds().describe(
          "Creative ids to report on, e.g. [9001]. Required; get them from list_creatives, or use campaign_stats for the whole campaign.",
        ),
      },
    },
    async ({ campaignId, dateFrom, dateTo, creativeIds }) => {
      try {
        return ok(await client.creativeStats({ campaignId, dateFrom, dateTo, creativeIds }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
