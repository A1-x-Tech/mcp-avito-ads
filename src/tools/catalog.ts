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
      from: isoDate().describe("Начало диапазона, YYYY-MM-DD."),
      to: isoDate().describe("Конец диапазона, YYYY-MM-DD."),
    })
    .optional()
    .describe(description);

const limitField = () => pageLimit().optional().describe("Размер страницы, 1..100. По умолчанию 20.");

const pageField = () => pageNumber().optional().describe("Номер страницы, нумерация с 1. По умолчанию 1.");

const paymentModelsField = () =>
  z.array(paymentModelEnum()).optional().describe("Оставить только эти модели оплаты: CPM, CPC.");

const campaignTypesField = () =>
  z.array(campaignTypeEnum()).optional().describe("Оставить только эти типы кампаний: textImage, HTML, video.");

const rawFilter = () =>
  filterObject()
    .optional()
    .describe(
      "Универсальный фильтр: дополнительные ключи, которые подмешиваются в фильтр запроса как есть (в написании API). При конфликте побеждают именованные поля выше.",
    );

export function registerCatalogTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "list_campaigns",
    {
      title: "Список рекламных кампаний",
      annotations: READ_ONLY,
      description:
        "Перечисляет рекламные кампании аккаунта постранично. Возвращает {total, items, page, limit, hasNextPage} плюс apiPointBalance — остаток недельных баллов API, которые пополняются по понедельникам в 00:00 UTC. У каждой кампании есть id, name, status, budget (рубли), paymentModel (CPM/CPC), campaignType, startDate/endDate, advertiserId, contractId, managerID и отметки времени. Поля фильтра объединяются по И, и каждый список оставляет только перечисленные в нём значения. Через этот API нельзя создать, изменить, приостановить, возобновить, заархивировать или удалить кампанию и нельзя тронуть её таргетинг — единственные доступные где-либо изменения это change_group_budget и change_group_price для группы объявлений.",
      inputSchema: {
        ids: idList("Оставить кампании с этими id."),
        statuses: z
          .array(campaignStatusEnum())
          .optional()
          .describe(
            "Оставить кампании с этими статусами: draft, in_moderation, moderation_failed, partial_moderation, active, paused, stopped, finished, archived.",
          ),
        campaignTypes: campaignTypesField(),
        paymentModels: paymentModelsField(),
        advertisers: idList("Оставить кампании этих рекламодателей (по id)."),
        managers: idList("Оставить кампании этих менеджеров — пользователей аккаунта (по id)."),
        contractIds: idList("Оставить кампании по этим договорам (по id)."),
        additionalAgreementIds: idList("Оставить кампании по этим дополнительным соглашениям (по id)."),
        createdAt: dateRange("Оставить кампании, созданные в этом диапазоне: {from, to}, YYYY-MM-DD."),
        timeFrame: dateRange("Оставить кампании, период размещения которых попадает в этот диапазон: {from, to}, YYYY-MM-DD."),
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
      title: "Список групп объявлений",
      annotations: READ_ONLY,
      description:
        "Перечисляет группы объявлений аккаунта постранично. Возвращает {total, items, page, limit, hasNextPage} плюс apiPointBalance (остаток недельных баллов API). Группа — тот уровень, на котором лежат деньги: в каждом элементе id, name, campaignID, status, budget и price (ставка) в рублях, paymentModel, campaignType, advertiserID, haveCreative и отметки времени. Эти два числа меняют change_group_budget / change_group_price — других изменяемых полей во всём дереве рекламных объектов нет. Создать, переименовать, приостановить, возобновить или удалить группу здесь нельзя, таргетинг групп не выведен.",
      inputSchema: {
        ids: idList("Оставить группы объявлений с этими id."),
        campaignIds: idList("Оставить группы этих кампаний (по id)."),
        statuses: z
          .array(groupStatusEnum())
          .optional()
          .describe(
            "Оставить группы с этими статусами: draft, in_moderation, moderation_failed, will_launch_soon, active, will_stop_soon, pausing, paused, unpausing, stopped, finished, archived.",
          ),
        paymentModels: paymentModelsField(),
        paces: z
          .array(z.string().min(1))
          .optional()
          .describe("Оставить группы с этими режимами распределения бюджета. Значения произвольные: фиксированного словаря для этого фильтра в SDK нет."),
        advertisers: idList("Оставить группы этих рекламодателей (по id)."),
        managers: idList("Оставить группы этих менеджеров — пользователей аккаунта (по id)."),
        timeFrame: dateRange("Оставить группы, период размещения которых попадает в этот диапазон: {from, to}, YYYY-MM-DD."),
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
      title: "Список креативов",
      annotations: READ_ONLY,
      description:
        "Перечисляет креативы аккаунта — сами объявления — постранично. Возвращает {total, items, page, limit, hasNextPage} плюс apiPointBalance (остаток недельных баллов API). У каждого креатива есть id, name, title, description, buttonText, link, status, groupID, campaignID, advertiserID, paymentModel, campaignType и legalInfo (данные рекламного реестра / ERID). Только чтение: загрузить, изменить, отправить на модерацию, приостановить или удалить креатив через этот API нельзя — изменять можно только бюджет и ставку группы объявлений.",
      inputSchema: {
        ids: idList("Оставить креативы с этими id."),
        groupIds: idList("Оставить креативы этих групп объявлений (по id)."),
        campaignIds: idList("Оставить креативы этих кампаний (по id)."),
        statuses: z
          .array(creativeStatusEnum())
          .optional()
          .describe(
            "Оставить креативы с этими статусами: draft, ready_for_moderation, in_moderation, moderation_failed, erir_registration, active, paused, stopped, finished, archived.",
          ),
        campaignTypes: campaignTypesField(),
        paymentModels: paymentModelsField(),
        advertisers: idList("Оставить креативы этих рекламодателей (по id)."),
        managers: idList("Оставить креативы этих менеджеров — пользователей аккаунта (по id)."),
        timeFrame: dateRange("Оставить креативы, период размещения которых попадает в этот диапазон: {from, to}, YYYY-MM-DD."),
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
      title: "Изменить бюджет группы объявлений",
      annotations: WRITE,
      description:
        "Задаёт бюджет одной группы объявлений в рублях (не меньше 1). Значение заменяет текущий бюджет, а не прибавляется к нему, поэтому повторный вызов безопасен. Принимают его только группы с ручным управлением ставками, остальным API отказывает. Возвращает подтверждение API плюс apiPointBalance. Изменить бюджет кампании, ставку (для неё есть change_group_price) или статус группы нельзя — приостановить, возобновить или удалить группу этот API вообще не умеет. Текущий бюджет стоит сначала посмотреть через list_groups.",
      inputSchema: {
        groupId: entityId().describe("Id изменяемой группы объявлений, из list_groups."),
        budget: rubleAmount().describe("Новый бюджет в рублях, не меньше 1. Заменяет текущее значение."),
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
      title: "Изменить ставку группы объявлений",
      annotations: WRITE,
      description:
        "Задаёт ставку одной группы объявлений (в API она называется price) в рублях (не меньше 1). Единица зависит от paymentModel группы: рубли за 1000 показов при CPM, рубли за клик при CPC. Значение заменяет текущую ставку, а не прибавляется к ней, поэтому повторный вызов безопасен. Принимают его только группы с ручным управлением ставками. Возвращает подтверждение API плюс apiPointBalance. Изменить бюджет (для него есть change_group_budget) или статус группы нельзя — приостановить, возобновить или удалить группу этот API вообще не умеет. Текущую ставку показывает поле price в list_groups.",
      inputSchema: {
        groupId: entityId().describe("Id изменяемой группы объявлений, из list_groups."),
        price: rubleAmount().describe("Новая ставка в рублях, не меньше 1. Заменяет текущее значение."),
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
