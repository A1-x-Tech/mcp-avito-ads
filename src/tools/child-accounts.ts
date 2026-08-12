/**
 * Agency sub-accounts and money movement.
 *
 * Every endpoint here is scoped to the configured account (AVITO_ADS_ACCOUNT_ID),
 * which acts as the parent: children are listed under it, created under it, and
 * transfers always leave it. That is why the transfer tools take only a
 * destination id — the sender is fixed by the config and can never be chosen by
 * the model.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AvitoAdsClient } from "../client.js";
import { CREATE, DESTRUCTIVE, entityId, fail, ok, READ_ONLY, rubleAmount } from "./util.js";

export function registerChildAccountTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "list_child_accounts",
    {
      title: "Дочерние аккаунты",
      annotations: READ_ONLY,
      description:
        "Перечисляет дочерние (суб-)аккаунты настроенного агентского аккаунта. Каждая запись — {account:{id,shortName}, contract}. Балансов здесь НЕТ, для них есть list_child_accounts_with_balances. Возвращает всех дочерних за один вызов: без постраничной выдачи, фильтров и поиска. `apiPointBalance` в любом ответе этого сервера — остаток баллов API на текущую неделю (квота пополняется по понедельникам в 00:00 UTC); по нему и стоит рассчитывать частоту вызовов.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.listChildAccounts());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_child_accounts_with_balances",
    {
      title: "Дочерние аккаунты с балансами",
      annotations: READ_ONLY,
      description:
        "Тот же список, что и list_child_accounts, плюс баланс каждого дочернего аккаунта: {balance, bonusBalance} в рублях и бонусных рублях. Позволяет увидеть, у кого кончились деньги, перед transfer_funds / transfer_bonus и убедиться, что перевод дошёл. Показывает только балансы дочерних аккаунтов — баланс родительского даёт get_balance.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.listChildAccountsWithBalances());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_child_account",
    {
      title: "Создать дочерний аккаунт без права оплаты",
      annotations: CREATE,
      description:
        "Создаёт дочерний аккаунт без права оплаты под настроенным агентским аккаунтом и возвращает {accountID, clientKey, clientSecret} — собственные учётные данные API нового аккаунта, которые выдаются только здесь, поэтому сохранить их нужно сразу. Без права оплаты означает, что аккаунт не может пополнить свой баланс сам: деньги приходят из родительского через transfer_funds. Создать аккаунт с правом оплаты, переименовать или удалить аккаунт, а также прочитать секрет заново нельзя. Два вызова создают два аккаунта.",
      inputSchema: {
        shortName: z
          .string()
          .min(1)
          .describe('Отображаемое название нового дочернего аккаунта, например "ООО Ромашка".'),
        isSelfAdvertisingEnabled: z
          .boolean()
          .describe(
            "Может ли новый аккаунт вести саморекламу (рекламировать собственные товары и услуги). Обязательное поле — значение указывается явно, флаг уходит в API при каждом создании.",
          ),
      },
    },
    async ({ shortName, isSelfAdvertisingEnabled }) => {
      try {
        return ok(await client.createNonpayerChildAccount({ shortName, isSelfAdvertisingEnabled }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "transfer_funds",
    {
      title: "Перевести деньги на другой аккаунт",
      annotations: DESTRUCTIVE,
      description:
        "Переводит РЕАЛЬНЫЕ ДЕНЬГИ с настроенного аккаунта на другой (обычно на один из дочерних): `amount` рублей, минимум 1. Через этот API перевод необратим — нет ни отмены, ни отката, ни журнала переводов; вернуть деньги можно только встречным переводом, а для него аккаунт-получатель должен уметь отправлять средства. При успехе возвращается пустой объект data: любой ответ без ошибки означает, что перевод выполнен, и повторять вызов нельзя. После сетевой или серверной ошибки исход неизвестен — прежде чем повторять, следует проверить list_child_accounts_with_balances, иначе деньги уйдут дважды.",
      inputSchema: {
        accountIdTo: entityId().describe(
          "Id аккаунта назначения — того, кто ПОЛУЧАЕТ деньги. Отправитель — всегда настроенный аккаунт, и его нельзя переопределить. Id дочерних аккаунтов даёт list_child_accounts.",
        ),
        amount: rubleAmount().describe("Сумма в рублях. Минимум 1; меньшее значение отклоняется."),
      },
    },
    async ({ accountIdTo, amount }) => {
      try {
        return ok(await client.transferFunds({ accountIdTo, amount }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "transfer_bonus",
    {
      title: "Перевести бонусные рубли на другой аккаунт",
      annotations: DESTRUCTIVE,
      description:
        "Переводит бонусные рубли (`bonusBalance` — промо-средства, которыми можно оплачивать рекламу, но нельзя вывести деньгами) с настроенного аккаунта на другой: `amount` бонусных рублей, минимум 1. Правила те же, что у transfer_funds: через этот API перевод необратим, пустой объект data означает, что он прошёл, а после сетевой или серверной ошибки следует проверить list_child_accounts_with_balances, а не повторять вызов. Переводит только бонусы — реальные деньги идут через transfer_funds.",
      inputSchema: {
        accountIdTo: entityId().describe(
          "Id аккаунта назначения — того, кто ПОЛУЧАЕТ бонусы. Отправитель — всегда настроенный аккаунт.",
        ),
        amount: rubleAmount().describe("Сумма в бонусных рублях. Минимум 1; меньшее значение отклоняется."),
      },
    },
    async ({ accountIdTo, amount }) => {
      try {
        return ok(await client.transferBonus({ accountIdTo, amount }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
