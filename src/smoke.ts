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
  const points = res.apiPointBalance === null ? "not reported" : String(res.apiPointBalance);
  console.log(`${label} — points left: ${points}`);
  return res.data;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new AvitoAdsClient(config);
  console.log(`Avito Ads smoke check (read-only) — account ${config.accountId}, ${config.environment}\n`);

  const account = await step("account   ", client.getAccount());
  console.log(`            ${account.shortName ?? account.longName ?? "?"} (INN ${account.inn ?? "?"})`);

  const balance = await step("balance   ", client.getBalance());
  console.log(`            ${balance.balance ?? "?"} RUB, ${balance.bonusBalance ?? "?"} bonus RUB`);

  const campaigns = await step("campaigns ", client.listCampaigns({ limit: 3 }));
  console.log(`            ${campaigns.items.length} of ${campaigns.total} returned`);
  for (const campaign of campaigns.items) {
    console.log(`            - [${campaign.id ?? "?"}] ${campaign.name ?? ""} (${campaign.status ?? "?"})`);
  }

  const left = lastBalance === null ? "not reported by the API" : `${lastBalance} points`;
  console.log(`\nSmoke check passed. Weekly quota left: ${left} (replenished Mondays 00:00 UTC).`);
}

main().catch((err) => {
  // Missing credentials are a user error, not a bug: report them without a stack.
  if (err instanceof ConfigError) {
    console.error(`Smoke check cannot run: ${err.message}`);
    console.error(
      "Set AVITO_ADS_CLIENT_ID, AVITO_ADS_CLIENT_SECRET and AVITO_ADS_ACCOUNT_ID " +
        "(add AVITO_ADS_ENVIRONMENT=sandbox to hit the sandbox instead of production).",
    );
    process.exit(1);
  }
  console.error(`\nSmoke check FAILED: ${err instanceof Error ? err.message : String(err)}`);
  // A bare 403 here is almost always the account id, not the key: the token is
  // minted for one account, and a mismatch fails exactly like a rights problem.
  if (err instanceof AvitoAdsError && err.status === 403) {
    console.error(
      "A 403 with no message means the token was issued for a different account — " +
        "check AVITO_ADS_ACCOUNT_ID is the account whose cabinet the key was created in.",
    );
  }
  process.exit(1);
});
