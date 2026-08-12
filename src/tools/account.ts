import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AvitoAdsClient } from "../client.js";
import { CREATE, fail, legalTypeEnum, ok, READ_ONLY } from "./util.js";

/**
 * Account-level tools: who the server is bound to, how much money is left, and
 * (sandbox only) minting a fresh test account.
 *
 * The account id is never a tool argument — it comes from `AVITO_ADS_ACCOUNT_ID`
 * via the config and the client injects it into every path.
 */

/**
 * The contact block of a new sandbox account. The API takes an arbitrary object
 * here (name / email / phone are the usual keys) and only insists it is not
 * empty, so it passes through as-is. A factory, like every schema helper in
 * util.ts, so the JSON schema stays inlined instead of collapsing into a $ref.
 */
const contactObject = () =>
  z.record(z.any()).refine((value) => Object.keys(value).length > 0, {
    message: "contact не может быть пустым — нужно передать хотя бы одно из name, email, phone",
  });

/** A required, non-empty legal-details string. */
const requiredText = () => z.string().min(1);

export function registerAccountTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "get_account",
    {
      title: "Реквизиты аккаунта",
      annotations: READ_ONLY,
      description:
        "Возвращает юридические реквизиты рекламного аккаунта, к которому привязан сервер: inn, kpp, ogrn, shortName, longName, legalAddress, actualAddress и блоки contact / manager. Аргументов не принимает — аккаунт задан в AVITO_ADS_ACCOUNT_ID и не выбирается для отдельного вызова. Денежных сумм не содержит (для них get_balance), данных кампаний тоже. Как и у всех инструментов здесь, в ответе есть apiPointBalance: остаток баллов API на текущую неделю (квота пополняется по понедельникам в 00:00 UTC).",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.getAccount());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Баланс аккаунта",
      annotations: READ_ONLY,
      description:
        "Возвращает текущий баланс настроенного рекламного аккаунта в рублях: balance (реальные деньги) и bonusBalance (бонусные рубли, которые можно тратить только на рекламу). Аргументов не принимает. Это срез на текущий момент, а не история — расход за период дают инструменты статистики. Аккаунт не пополняет.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.getBalance());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_sandbox_account",
    {
      title: "Создать аккаунт в песочнице",
      annotations: CREATE,
      description:
        'ТОЛЬКО ПЕСОЧНИЦА: создаёт тестовый аккаунт рекламодателя и возвращает его accountID. Сервер отклоняет вызов, если не задано AVITO_ADS_ENVIRONMENT=sandbox, и такой отказ не стоит балла API. contact — непустой объект, например {"name":"Иван Иванов","email":"ivan@example.com","phone":"+79001234567"}; пустой отклоняется до отправки запроса. Два вызова создают два аккаунта. Изменить или удалить аккаунт нельзя, а сервер продолжает работать с AVITO_ADS_ACCOUNT_ID: новый id сам не подхватывается, для работы с ним его нужно прописать в конфигурации.',
      inputSchema: {
        inn: requiredText().describe("ИНН тестовой компании: 10 цифр для юрлица, 12 для ИП."),
        shortName: requiredText().describe('Краткое юридическое наименование, например "ООО Ромашка".'),
        longName: requiredText().describe('Полное юридическое наименование, например "Общество с ограниченной ответственностью Ромашка".'),
        ogrn: requiredText().describe("Государственный регистрационный номер (ОГРН для юрлица, ОГРНИП для ИП)."),
        legalAddress: requiredText().describe("Юридический адрес."),
        actualAddress: requiredText().describe("Фактический почтовый адрес; может совпадать с legalAddress."),
        contact: contactObject().describe(
          'Контактное лицо аккаунта; передаётся в API как есть и не может быть пустым, например {"name":"Иван Иванов","email":"ivan@example.com","phone":"+79001234567"}.',
        ),
        kpp: z
          .string()
          .min(1)
          .optional()
          .describe("КПП. Есть у юрлиц (legalType ul); у ИП его нет — тогда поле опускается."),
        legalType: legalTypeEnum()
          .optional()
          .describe("Организационно-правовая форма: ul — юрлицо, ip — ИП."),
      },
    },
    async ({ inn, shortName, longName, ogrn, legalAddress, actualAddress, contact, kpp, legalType }) => {
      try {
        // POST v1/account/{accountID} carries legal-entity details to the
        // *configured* account's endpoint. The SDK documents this endpoint as
        // sandbox-only but nothing says production refuses it, so the refusal is
        // ours: bound to production, the call never goes out (and costs nothing).
        if (client.environment !== "sandbox") {
          return fail(
            "create_sandbox_account работает только с песочницей, а этот сервер привязан к окружению " +
              `${client.environment}. Чтобы им воспользоваться, нужно задать AVITO_ADS_ENVIRONMENT=sandbox и перезапустить сервер.`,
          );
        }
        return ok(
          await client.createSandboxAccount({
            inn,
            shortName,
            longName,
            ogrn,
            legalAddress,
            actualAddress,
            contact,
            kpp,
            legalType,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
