import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AvitoAdsClient } from "../client.js";
import {
  contractActionEnum,
  contractSubjectEnum,
  contractTypeEnum,
  counterpartyTypeEnum,
  CREATE,
  entityId,
  entityIds,
  fail,
  isoDate,
  legalRoleEnum,
  legalTypeEnum,
  ok,
  pageLimit,
  pageNumber,
  READ_ONLY,
} from "./util.js";

/**
 * ORD paperwork: advertisers and contracts.
 *
 * Russian ad-marking law (ORD) requires every campaign to name a registered
 * advertiser and the contract it runs under, so these four tools are the first
 * step of any campaign setup. Both entities are append-only in this API — there
 * is no edit and no delete endpoint — which is why the creates are annotated as
 * non-idempotent writes and their descriptions say so.
 *
 * The per-type contract rules are NOT re-implemented here: `client.createContract`
 * runs `validateContractInput` and rejects before the request goes out, so the
 * rules live in exactly one place. This module only pins the vocabularies (the
 * zod enums) and the field names.
 */

/**
 * Legal details of a counterparty, as the contract's `intermediary` (contractor)
 * block. Same shape the account and advertiser records use. Extra keys are
 * passed through untouched so a field the SDK does not know about still reaches
 * the API.
 */
const intermediaryDetails = () =>
  z
    .object({
      inn: z.string().min(1).describe("ИНН исполнителя."),
      shortName: z.string().optional().describe('Краткое юридическое наименование, например "ООО Реклама".'),
      longName: z.string().optional().describe("Полное юридическое наименование."),
      ogrn: z.string().optional().describe("Государственный регистрационный номер (ОГРН для юрлица, ОГРНИП для ИП)."),
      kpp: z.string().optional().describe("КПП; только для юрлиц (ul)."),
      legalAddress: z.string().optional().describe("Юридический адрес."),
      actualAddress: z.string().optional().describe("Фактический (почтовый) адрес."),
      legalType: legalTypeEnum().optional().describe("Тип юридического лица: ul (юрлицо) или ip (ИП)."),
    })
    .passthrough();

export function registerOrdTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "create_advertiser",
    {
      title: "Зарегистрировать рекламодателя (ОРД)",
      annotations: CREATE,
      description:
        "Регистрирует рекламодателя (контрагента ОРД) под аккаунтом и возвращает {id} плюс apiPointBalance (остаток недельных баллов API). На этот id ссылаются кампании и договоры. Юридические реквизиты должны совпадать с госреестром: inn (10 цифр для ul, 12 для ip), ogrn и оба адреса; kpp — только для юрлиц (ul). legalRole задаёт роль по ОРД: rd (рекламодатель), ra (агентство), rr (распространитель). Эндпоинтов изменения и удаления нет: ошибочного рекламодателя можно только заместить новым, поэтому сначала стоит поискать готовую запись через list_advertisers.",
      inputSchema: {
        inn: z
          .string()
          .min(1)
          .describe("ИНН: 10 цифр для юрлица (ul), 12 для ИП (ip)."),
        shortName: z.string().min(1).describe('Краткое юридическое наименование, например "ООО Реклама".'),
        longName: z
          .string()
          .min(1)
          .describe('Полное юридическое наименование, например "Общество с ограниченной ответственностью Реклама".'),
        ogrn: z.string().min(1).describe("Государственный регистрационный номер (ОГРН для ul, ОГРНИП для ip)."),
        legalAddress: z.string().min(1).describe("Юридический адрес."),
        actualAddress: z.string().min(1).describe("Фактический (почтовый) адрес; если он совпадает с legalAddress, повторяется тот же."),
        legalRole: legalRoleEnum().describe(
          "Роль контрагента по ОРД: rd (рекламодатель), ra (агентство), rr (распространитель).",
        ),
        legalType: legalTypeEnum().describe("Тип юридического лица: ul (юрлицо) или ip (ИП)."),
        kpp: z.string().optional().describe("КПП. Только для юрлиц (ul); для ip опускается."),
      },
    },
    async ({ inn, shortName, longName, ogrn, legalAddress, actualAddress, legalRole, legalType, kpp }) => {
      try {
        return ok(
          await client.createAdvertiser({
            inn,
            shortName,
            longName,
            ogrn,
            legalAddress,
            actualAddress,
            legalRole,
            legalType,
            kpp,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_advertisers",
    {
      title: "Список рекламодателей",
      annotations: READ_ONLY,
      description:
        "Возвращает одну страницу рекламодателей, зарегистрированных под аккаунтом: {total, items, page, limit, hasNextPage} плюс apiPointBalance (остаток недельных баллов API). В каждом элементе id, shortName, longName, inn, ogrn, kpp, legalAddress, actualAddress, legalType (ul|ip) и legalRole (rd|ra|rr). Сузить выдачу можно через filter.ids / filter.inns / filter.roles; полнотекстового поиска нет, совпадения по названиям придётся искать самостоятельно. limit — 1..100 (по умолчанию 20); нумерация page с 1.",
      inputSchema: {
        filter: z
          .object({
            ids: entityIds().optional().describe("Только рекламодатели с этими id."),
            inns: z.array(z.string()).optional().describe("Только рекламодатели с этими ИНН."),
            roles: z
              .array(legalRoleEnum())
              .optional()
              .describe("Только эти роли ОРД: rd (рекламодатель), ra (агентство), rr (распространитель)."),
          })
          .passthrough()
          .optional()
          .describe("Фильтр страницы. Без него возвращаются все рекламодатели."),
        limit: pageLimit().optional().describe("Размер страницы, 1..100. По умолчанию 20."),
        page: pageNumber().optional().describe("Номер страницы, нумерация с 1. По умолчанию 1."),
      },
    },
    async ({ filter, limit, page }) => {
      try {
        return ok(await client.listAdvertisers({ filter, limit, page }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_contract",
    {
      title: "Зарегистрировать договор (ОРД)",
      annotations: CREATE,
      description:
        "Регистрирует договор ОРД между аккаунтом и рекламодателем и возвращает {id} плюс apiPointBalance (остаток недельных баллов API). Набор обязательных полей зависит от type: service требует subject, isReportingRequired, date и number (cid отклоняется); intermediary — всё то же плюс object и isFundsAllocationToPrincipal (cid отклоняется); external — только cid (parentId отклоняется). Юридические реквизиты исполнителя передаются в intermediary — они обязательны, если не задан parentId; с parentId запись становится дополнительным соглашением к тому договору, и intermediary в ней быть не должно. Эндпоинтов изменения и удаления нет, поэтому ошибочный договор остаётся на аккаунте навсегда.",
      inputSchema: {
        advertiserId: entityId().describe("Рекламодатель, с которым заключён договор (клиент). Id даёт list_advertisers."),
        type: contractTypeEnum().describe(
          "Тип договора: service (оказание услуг), intermediary (посреднический), external (заключён вне Авито, определяется по cid).",
        ),
        counterpartyType: counterpartyTypeEnum().describe(
          "Тип контрагента — уходит в API в поле `description`: direct_with_advertiser или advertiser_intermediary.",
        ),
        subject: contractSubjectEnum()
          .optional()
          .describe(
            "Предмет договора: org-distribution, mediation, distribution, representation, other. Обязателен для service и intermediary.",
          ),
        object: contractActionEnum()
          .optional()
          .describe(
            "Действие по договору, поле API `object`: distribution, conclude, commercial, other. Обязательно для intermediary.",
          ),
        cid: z
          .string()
          .min(1)
          .optional()
          .describe("Внешний идентификатор договора (со стороны ERID). Обязателен для типа external, для остальных отклоняется."),
        date: isoDate().optional().describe("Дата договора, YYYY-MM-DD. Обязательна для service и intermediary."),
        number: z.string().min(1).optional().describe("Номер договора. Обязателен для service и intermediary."),
        isReportingRequired: z
          .boolean()
          .optional()
          .describe("Нужны ли по договору акты и отчёты. Обязательно для service и intermediary."),
        isFundsAllocationToPrincipal: z
          .boolean()
          .optional()
          .describe("Распределяются ли средства в пользу принципала. Обязательно для intermediary."),
        parentId: entityId()
          .optional()
          .describe("Id родительского договора. Задаётся, чтобы зарегистрировать дополнительное соглашение; тогда intermediary опускается."),
        intermediary: intermediaryDetails()
          .optional()
          .describe("Юридические реквизиты исполнителя (посредника). Обязательны, если не задан parentId."),
      },
    },
    async ({
      advertiserId,
      type,
      counterpartyType,
      subject,
      object,
      cid,
      date,
      number,
      isReportingRequired,
      isFundsAllocationToPrincipal,
      parentId,
      intermediary,
    }) => {
      try {
        return ok(
          await client.createContract({
            advertiserId,
            type,
            // The API names the counterparty type `description`; the tool takes
            // the SDK builder's clearer name and renames it here.
            description: counterpartyType,
            subject,
            object,
            cid,
            date,
            number,
            isReportingRequired,
            isFundsAllocationToPrincipal,
            parentId,
            intermediary,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_contracts",
    {
      title: "Список договоров",
      annotations: READ_ONLY,
      description:
        "Возвращает одну страницу договоров, зарегистрированных под аккаунтом: {total, items, page, limit, hasNextPage} плюс apiPointBalance (остаток недельных баллов API). В каждом элементе id, type, number, date, subject, object (действие по договору), cid, description (тип контрагента), parentId (заполнен у дополнительных соглашений) и юридические реквизиты клиента и исполнителя. Сузить выдачу можно через filter.ids / filter.numbers / filter.clients (id рекламодателей) / filter.contractors. limit — 1..100 (по умолчанию 20); нумерация page с 1.",
      inputSchema: {
        filter: z
          .object({
            ids: entityIds().optional().describe("Только договоры с этими id."),
            numbers: z.array(z.string()).optional().describe("Только договоры с этими номерами."),
            clients: entityIds().optional().describe("Только договоры, клиент которых — один из этих рекламодателей (по id)."),
            contractors: entityIds().optional().describe("Только договоры с этими исполнителями (посредниками) по id."),
          })
          .passthrough()
          .optional()
          .describe("Фильтр страницы. Без него возвращаются все договоры."),
        limit: pageLimit().optional().describe("Размер страницы, 1..100. По умолчанию 20."),
        page: pageNumber().optional().describe("Номер страницы, нумерация с 1. По умолчанию 1."),
      },
    },
    async ({ filter, limit, page }) => {
      try {
        return ok(await client.listContracts({ filter, limit, page }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
