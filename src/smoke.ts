#!/usr/bin/env node
/**
 * Live READ-ONLY smoke check against the configured Avito Ads account.
 *
 * Three of the cheapest calls the API has — account details, balance, and one
 * short page of campaigns — and not a single write endpoint: no transfers, no
 * budget or bid changes, no user or entity creation. Run it with your own
 * credentials in the environment.
 *
 * Every call costs weekly API points, so the remaining `Api-Point-Balance` is
 * printed after each step and again at the end: a smoke check that quietly ate
 * the quota would be worse than no smoke check at all.
 */
import { AvitoAdsClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { AvitoAdsError, type ApiResponse } from "./types.js";

/** Last balance the API reported, so the summary line can show where we landed. */
let lastBalance: number | null = null;

/** Runs one step, printing the point balance it came back with. */
async function step<T>(label: string, call: Promise<ApiResponse<T>>): Promise<T> {
  const res = await call;
  if (res.apiPointBalance !== null) lastBalance = res.apiPointBalance;
  const points = res.apiPointBalance === null ? "не сообщён" : String(res.apiPointBalance);
  console.log(`${label} — остаток баллов: ${points}`);
  return res.data;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new AvitoAdsClient(config);
  console.log(`Проверка Авито Рекламы (только чтение) — аккаунт ${config.accountId}, ${config.environment}\n`);

  const account = await step("аккаунт   ", client.getAccount());
  console.log(`            ${account.shortName ?? account.longName ?? "?"} (ИНН ${account.inn ?? "?"})`);

  const balance = await step("баланс    ", client.getBalance());
  console.log(`            ${balance.balance ?? "?"} ₽, ${balance.bonusBalance ?? "?"} бонусных ₽`);

  const campaigns = await step("кампании  ", client.listCampaigns({ limit: 3 }));
  console.log(`            возвращено ${campaigns.items.length} из ${campaigns.total}`);
  for (const campaign of campaigns.items) {
    console.log(`            - [${campaign.id ?? "?"}] ${campaign.name ?? ""} (${campaign.status ?? "?"})`);
  }

  const left = lastBalance === null ? "не сообщён API" : `${lastBalance} баллов`;
  console.log(`\nПроверка пройдена. Остаток недельной квоты: ${left} (пополняется по понедельникам в 00:00 UTC).`);
}

main().catch((err) => {
  // Missing credentials are a user error, not a bug: report them without a stack.
  if (err instanceof ConfigError) {
    console.error(`Проверку не запустить: ${err.message}`);
    console.error(
      "Нужно задать AVITO_ADS_CLIENT_ID, AVITO_ADS_CLIENT_SECRET и AVITO_ADS_ACCOUNT_ID " +
        "(и AVITO_ADS_ENVIRONMENT=sandbox, чтобы обращаться к песочнице вместо production).",
    );
    process.exit(1);
  }
  console.error(`\nПроверка ПРОВАЛЕНА: ${err instanceof Error ? err.message : String(err)}`);
  // A bare 403 here is almost always the account id, not the key: the token is
  // minted for one account, and a mismatch fails exactly like a rights problem.
  if (err instanceof AvitoAdsError && err.status === 403) {
    console.error(
      "403 без сообщения означает, что токен выдан для другого аккаунта: " +
        "AVITO_ADS_ACCOUNT_ID должен быть тем аккаунтом, в кабинете которого создан ключ.",
    );
  }
  process.exit(1);
});
