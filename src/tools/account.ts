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
    message: "contact must not be empty — pass at least one of name, email, phone",
  });

/** A required, non-empty legal-details string. */
const requiredText = () => z.string().min(1);

export function registerAccountTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "get_account",
    {
      title: "Account details",
      annotations: READ_ONLY,
      description:
        "Returns the legal details of the ad account this server is bound to: inn, kpp, ogrn, shortName, longName, legalAddress, actualAddress and the contact / manager blocks. Takes no arguments — the account is fixed by AVITO_ADS_ACCOUNT_ID and cannot be chosen per call. Carries no money figures (use get_balance) and no campaign data. Like every tool here, the result also reports apiPointBalance: the API points left this week (the quota refills Mondays 00:00 UTC).",
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
      title: "Account balance",
      annotations: READ_ONLY,
      description:
        "Returns the current balance of the configured ad account in rubles: balance (real money) and bonusBalance (bonus rubles, spendable on ads only). Takes no arguments. It is a snapshot of right now, not a history — for money spent over a period use the statistics tools. Does not top the account up.",
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
      title: "Create a sandbox account",
      annotations: CREATE,
      description:
        'SANDBOX ONLY: creates a test advertiser account and returns its accountID. This server refuses the call unless AVITO_ADS_ENVIRONMENT=sandbox, and the refusal costs no API point. contact must be a non-empty object, e.g. {"name":"Ivan Ivanov","email":"ivan@example.com","phone":"+79001234567"} — an empty one is rejected before any request goes out. Calling twice creates two accounts. It cannot edit or delete an account, and the server keeps working against AVITO_ADS_ACCOUNT_ID: the new id is not adopted, put it in the config to use it.',
      inputSchema: {
        inn: requiredText().describe("Taxpayer number (INN) of the test company: 10 digits for a company, 12 for a sole proprietor."),
        shortName: requiredText().describe('Short legal name, e.g. "OOO Romashka".'),
        longName: requiredText().describe('Full legal name, e.g. "Obshchestvo s ogranichennoy otvetstvennostyu Romashka".'),
        ogrn: requiredText().describe("State registration number (OGRN for a company, OGRNIP for a sole proprietor)."),
        legalAddress: requiredText().describe("Registered legal address."),
        actualAddress: requiredText().describe("Actual postal address; may repeat legalAddress."),
        contact: contactObject().describe(
          'Contact person of the account, passed to the API as-is and must not be empty, e.g. {"name":"Ivan Ivanov","email":"ivan@example.com","phone":"+79001234567"}.',
        ),
        kpp: z
          .string()
          .min(1)
          .optional()
          .describe("Tax registration reason code (KPP). Companies (legalType ul) have one; sole proprietors do not — omit it then."),
        legalType: legalTypeEnum()
          .optional()
          .describe("Legal form: ul = company, ip = sole proprietor."),
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
            "create_sandbox_account works only against the sandbox; this server is bound to " +
              `${client.environment}. Set AVITO_ADS_ENVIRONMENT=sandbox and restart to use it.`,
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
