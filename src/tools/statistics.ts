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
  "Тратит недельные баллы API; apiPointBalance в ответе — остаток до пополнения квоты в понедельник в 00:00 UTC, поэтому один широкий период предпочтительнее многих узких вызовов.";

/** The period rule, taken from the client's cap so the text cannot drift from the check. */
const PERIOD_NOTE = `Период включает обе границы, формат YYYY-MM-DD, длительность не больше ${MAX_STATS_PERIOD_DAYS} дней. `;

const DATE_FROM_NOTE = "Первый день периода, включительно (YYYY-MM-DD).";
const DATE_TO_NOTE = `Последний день периода, включительно (YYYY-MM-DD). Должен быть >= dateFrom, а период — не длиннее ${MAX_STATS_PERIOD_DAYS} дней.`;

export function registerStatisticsTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "campaign_stats",
    {
      title: "Статистика кампании",
      annotations: READ_ONLY,
      description:
        "Статистика ОДНОЙ кампании за период дат с разбивкой по группам и креативам: {campaign, groups[], creatives[]}. У каждой сущности есть data[] (по строке на день, с отметкой timestamp) и totalData (итог за период). Метрики в строке: views (показы), clicks (клики), ctr, spend (расход), spendBonus, cpm, cpc, а для видеокампаний ещё videoViews25/50/75/100, q25/q50/q75 и vtr; деньги в рублях, коэффициенты передаются как есть. " +
        PERIOD_NOTE +
        "Сводить несколько кампаний вместе не умеет, гранулярности мельче дня нет; campaignId даёт list_campaigns. " +
        POINTS_NOTE,
      inputSchema: {
        campaignId: entityId().describe("Кампания, по которой строится отчёт. Id можно найти через list_campaigns."),
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
      title: "Статистика групп объявлений",
      annotations: READ_ONLY,
      description:
        "Статистика по перечисленным группам одной кампании: плоский массив, по записи на группу объявлений ({id, name, paymentModel, campaignType, data[] по дням, totalData за период}). Метрики те же, что у campaign_stats — views (показы), clicks (клики), ctr, spend (расход), spendBonus, cpm, cpc, квартили видео, vtr, — деньги в рублях. Поле groupIds обязательно: инструмент сужает выборку, а не перечисляет её. " +
        PERIOD_NOTE +
        "Итогов по кампании не возвращает; чтобы охватить все группы кампании, есть campaign_stats с той же разбивкой. " +
        POINTS_NOTE,
      inputSchema: {
        campaignId: entityId().describe("Кампания, группы которой попадают в отчёт. Id можно найти через list_campaigns."),
        dateFrom: isoDate().describe(DATE_FROM_NOTE),
        dateTo: isoDate().describe(DATE_TO_NOTE),
        groupIds: entityIds().describe(
          "Id групп объявлений для отчёта, например [101, 102]. Обязательное поле; id даёт list_groups, а по всей кампании отчитывается campaign_stats.",
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
      title: "Статистика креативов",
      annotations: READ_ONLY,
      description:
        "Статистика по перечисленным креативам одной кампании: плоский массив, по записи на креатив ({id, name, groupId, paymentModel, campaignType, data[] по дням, totalData за период}). Метрики те же, что у campaign_stats — views (показы), clicks (клики), ctr, spend (расход), spendBonus, cpm, cpc, квартили видео, vtr, — деньги в рублях. Поле creativeIds обязательно: инструмент сужает выборку, а не перечисляет её. " +
        PERIOD_NOTE +
        "Итогов по кампании не возвращает; чтобы охватить все креативы кампании, есть campaign_stats с той же разбивкой. " +
        POINTS_NOTE,
      inputSchema: {
        campaignId: entityId().describe("Кампания, креативы которой попадают в отчёт. Id можно найти через list_campaigns."),
        dateFrom: isoDate().describe(DATE_FROM_NOTE),
        dateTo: isoDate().describe(DATE_TO_NOTE),
        creativeIds: entityIds().describe(
          "Id креативов для отчёта, например [9001]. Обязательное поле; id даёт list_creatives, а по всей кампании отчитывается campaign_stats.",
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
