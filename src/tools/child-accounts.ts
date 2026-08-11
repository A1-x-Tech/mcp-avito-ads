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
      title: "Child accounts",
      annotations: READ_ONLY,
      description:
        "Lists the child (sub-)accounts of the configured agency account. Each entry is {account:{id,shortName}, contract}. Balances are NOT included — use list_child_accounts_with_balances for those. Returns every child in one call: no paging, no filter, no search. `apiPointBalance` in every result of this server is the API points left for the current week (the quota refills Mondays 00:00 UTC); pace the calls by it.",
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
      title: "Child accounts with balances",
      annotations: READ_ONLY,
      description:
        "Same list as list_child_accounts, plus each child's balance: {balance, bonusBalance} in rubles and bonus rubles. Use it to see which child is out of money before transfer_funds / transfer_bonus, and to verify a transfer landed. Shows the children's balances only — the parent's own balance comes from get_balance.",
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
      title: "Create a non-payer child account",
      annotations: CREATE,
      description:
        "Creates a non-payer child account under the configured agency account and returns {accountID, clientKey, clientSecret} — the new account's own API credentials, handed out only here, so store them immediately. Non-payer means the child cannot top up its own balance: fund it with transfer_funds from the parent. Cannot create a payer account, cannot rename or delete one, and cannot re-read the secret later. Calling it twice creates two accounts.",
      inputSchema: {
        shortName: z
          .string()
          .min(1)
          .describe('Display name of the new child account, e.g. "OOO Romashka".'),
        isSelfAdvertisingEnabled: z
          .boolean()
          .describe(
            "Whether the new account may run self-advertising (advertise its own goods and services). Required — state it explicitly, the API is sent this flag on every create.",
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
      title: "Transfer money to another account",
      annotations: DESTRUCTIVE,
      description:
        "Moves REAL MONEY out of the configured account into another account (normally one of its children): `amount` rubles, minimum 1. Not reversible through this API — there is no undo, no cancel and no transfer log; the only way back is a second transfer in the other direction, which needs the destination account to be able to send funds. A success returns an empty data object: treat any non-error response as done and never repeat the call. After a network or server error the outcome is unknown — check list_child_accounts_with_balances before retrying, or the money moves twice.",
      inputSchema: {
        accountIdTo: entityId().describe(
          "Destination account id — the account that RECEIVES the money. The sender is always the configured account and cannot be overridden. Get child ids from list_child_accounts.",
        ),
        amount: rubleAmount().describe("Amount in rubles. Minimum 1; anything less is rejected."),
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
      title: "Transfer bonus rubles to another account",
      annotations: DESTRUCTIVE,
      description:
        "Moves bonus rubles (the `bonusBalance` — promotional funds that buy ads but cannot be withdrawn as cash) out of the configured account into another account: `amount` bonus rubles, minimum 1. Same rules as transfer_funds: not reversible through this API, an empty data object means it went through, and after a network or server error check list_child_accounts_with_balances instead of repeating the call. It moves bonuses only — real money goes through transfer_funds.",
      inputSchema: {
        accountIdTo: entityId().describe(
          "Destination account id — the account that RECEIVES the bonuses. The sender is always the configured account.",
        ),
        amount: rubleAmount().describe("Amount in bonus rubles. Minimum 1; anything less is rejected."),
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
