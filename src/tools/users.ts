import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AvitoAdsClient } from "../client.js";
import { DESTRUCTIVE, entityId, fail, ok, READ_ONLY, userRoleEnum, WRITE } from "./util.js";

/**
 * Access management for the configured ad account.
 *
 * The account id comes from the server config, so no tool here takes one: they
 * all act on that one account. Every result is the client's envelope —
 * `{data, apiPointBalance}` — so the agent sees how much of the weekly point
 * quota is left (it refills Mondays at 00:00 UTC).
 */
export function registerUserTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "list_users",
    {
      title: "Пользователи аккаунта",
      annotations: READ_ONLY,
      description:
        "Перечисляет пользователей с доступом к рекламному аккаунту — по одной записи {id, role, hasLoggedIn} на пользователя, где role это admin или viewer, а hasLoggedIn показывает, входил ли приглашённый хоть раз. Эти id принимают set_user_role и delete_user. Работает в пределах настроенного аккаунта: пользователей дочернего аккаунта не покажет. Вместе с данными возвращает apiPointBalance (остаток недельных баллов).",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.listUsers());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_user",
    {
      title: "Выдать пользователю доступ",
      annotations: WRITE,
      description:
        "Выдаёт существующему пользователю Авито доступ к рекламному аккаунту с указанной ролью. userId — числовой id пользователя Авито; пригласить по почте или телефону и создать аккаунт Авито этот инструмент не может. Если доступ уже есть, роль меняется через set_user_role. Возвращает подтверждение API плюс apiPointBalance.",
      inputSchema: {
        userId: entityId().describe("Числовой id пользователя Авито, которому выдаётся доступ, например 94235311."),
        role: userRoleEnum().describe(
          "admin — полный доступ, включая пользователей, переводы денег и правки кампаний; viewer — только чтение.",
        ),
      },
    },
    async ({ userId, role }) => {
      try {
        return ok(await client.addUser({ userId, role }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_user_role",
    {
      title: "Изменить роль пользователя",
      annotations: WRITE,
      description:
        "Меняет роль пользователя, у которого уже есть доступ к рекламному аккаунту. Назначение той же роли, что стоит сейчас, ничего не меняет. Доступ не выдаёт (для этого add_user) и не отзывает (для этого delete_user). Возвращает подтверждение API плюс apiPointBalance.",
      inputSchema: {
        userId: entityId().describe("Числовой id пользователя Авито, как его возвращает list_users."),
        role: userRoleEnum().describe(
          "admin — полный доступ, включая пользователей, переводы денег и правки кампаний; viewer — только чтение.",
        ),
      },
    },
    async ({ userId, role }) => {
      try {
        return ok(await client.setUserRole({ userId, role }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_user",
    {
      title: "Отозвать доступ пользователя",
      annotations: DESTRUCTIVE,
      description:
        "Отзывает доступ пользователя к рекламному аккаунту. Операция разрушительная: вернуть доступ можно только через add_user с явно указанной ролью. Аккаунт Авито этого человека, его кампании и историю расходов не удаляет. Возвращает подтверждение API плюс apiPointBalance.",
      inputSchema: {
        userId: entityId().describe("Числовой id пользователя Авито, которого нужно убрать из аккаунта, как его возвращает list_users."),
      },
    },
    async ({ userId }) => {
      try {
        return ok(await client.deleteUser(userId));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
