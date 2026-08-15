import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AvitoAdsClient, HttpMethod } from "../client.js";
import { DESTRUCTIVE, fail, ok } from "./util.js";

/**
 * Only GET is guaranteed not to change the account. This API also uses POST for
 * reads (every list endpoint and all three statistics endpoints), so the gate
 * below stops more than it strictly has to — that is the point: a mistyped POST
 * can reach funds-transfer or create-advertiser.
 */
export function isReadMethod(method: string): boolean {
  return method.toUpperCase() === "GET";
}

/**
 * Fills in the account id the model is not given. Every Ads path is scoped as
 * `v1/account/{accountID}/...`, but the account comes from the server config,
 * so the placeholder is substituted here instead of being guessed.
 *
 * Substitution alone is not the guard: a path that spells another account id
 * out in full is rejected by the client's `resolve`, which checks the *resolved*
 * path and so cannot be dodged with `..`.
 *
 * On a degraded start the account id is undefined; the substitution result is
 * moot then, because `client.request` rejects the call with CredentialsError
 * before the path is ever resolved.
 */
export function expandAccountPath(path: string, accountId: number | undefined): string {
  return path.replace(/\{account_?id\}/gi, String(accountId));
}

export function registerRawTool(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "raw_request",
    {
      title: "Прямой вызов API Авито Рекламы",
      // Escape hatch: it can reach every write endpoint, funds-transfer and
      // delete-user included, so it carries the destructive hint.
      annotations: DESTRUCTIVE,
      description:
        'Универсальный запрос к любому пути API Авито Рекламы — для эндпоинтов, у которых нет отдельного инструмента, например GET "v1/account/{accountID}/balance" или POST "v1/account/{accountID}/campaigns". Пути задаются относительно базы API и привязаны к аккаунту: подстановка {accountID} заменяется на настроенный id аккаунта, путь с другим аккаунтом отклоняется, как и путь, выходящий за базу API. `body` отправляется как JSON. Через него доступны все пишущие эндпоинты — funds-transfer, bonus-transfer, delete-user и create-*, — причём без клиентских проверок, которые делают отдельные инструменты, и ничего из этого не отменить; когда специальный инструмент есть, лучше взять его: transfer_funds / delete_user / create_*. confirmWrite=true — явное подтверждение того, что путь может писать, поэтому перед установкой флага путь стоит проверить: POST используется и для безобидных чтений — списков и статистики, — которым флаг тоже нужен. GET выполняется без ограничений. Возвращает сырой ответ плюс apiPointBalance (остаток недельных баллов).',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Путь API, например "v1/account/{accountID}/groups" или "v1/account/{accountID}/campaigns/123/stats".',
          ),
        method: z.enum(["GET", "POST", "DELETE"]).optional().describe("HTTP-метод. По умолчанию GET."),
        body: z
          .record(z.any())
          .optional()
          .describe('Тело запроса в JSON, например {"filter":{},"limit":20,"page":1} для эндпоинта списка.'),
        confirmWrite: z
          .boolean()
          .optional()
          .describe(
            "Для POST и DELETE должен быть true. Установка флага подтверждает, что путь может писать: funds-transfer и delete-user — такие же POST/DELETE, как и любое чтение списка.",
          ),
      },
    },
    async ({ path, method, body, confirmWrite }) => {
      try {
        const m = (method ?? "GET") as HttpMethod;
        // GET is the default and `body` is right there in the schema, so asking
        // for a filtered read as GET+body is the obvious mistake to make. fetch
        // would answer with an opaque "Request with GET/HEAD method cannot have
        // body", so name the actual fix instead: this API reads over POST.
        if (m === "GET" && body !== undefined) {
          return fail(
            `GET-запрос не может нести тело. Авито отдаёт чтения с фильтром (списки, статистику) через POST: ` +
              `нужно повторить "${path}" с method="POST" и confirmWrite=true либо убрать тело.`,
          );
        }
        if (!isReadMethod(m) && confirmWrite !== true) {
          return fail(`"${m} ${path}" может изменить данные аккаунта. Для выполнения нужно повторить вызов с confirmWrite=true.`);
        }
        return ok(await client.request(m, expandAccountPath(path, client.accountId), body));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
