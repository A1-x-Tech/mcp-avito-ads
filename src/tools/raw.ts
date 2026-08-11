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
 */
export function expandAccountPath(path: string, accountId: number): string {
  return path.replace(/\{account_?id\}/gi, String(accountId));
}

export function registerRawTool(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "raw_request",
    {
      title: "Raw Avito Ads API call",
      // Escape hatch: it can reach every write endpoint, funds-transfer and
      // delete-user included, so it carries the destructive hint.
      annotations: DESTRUCTIVE,
      description:
        'Escape hatch to call any Avito Ads API path directly, for endpoints without a dedicated tool — e.g. GET "v1/account/{accountID}/balance" or POST "v1/account/{accountID}/campaigns". Paths are relative to the API base and account-scoped; the literal {accountID} placeholder is replaced with the configured account id, a path naming a different account is refused, and so is one that escapes the API base. `body` is sent as JSON. It can reach every write endpoint — funds-transfer, bonus-transfer, delete-user and the create-* endpoints — with none of the client-side validation the dedicated tools apply, and nothing here is reversible; prefer transfer_funds / delete_user / create_* when they exist. confirmWrite=true is your explicit acknowledgement that the path may write, so check the path before setting it — POST is also used for harmless list and statistics reads, which need the flag too. GET runs freely. Returns the raw response plus apiPointBalance (weekly points left).',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'API path, e.g. "v1/account/{accountID}/groups" or "v1/account/{accountID}/campaigns/123/stats".',
          ),
        method: z.enum(["GET", "POST", "DELETE"]).optional().describe("HTTP method. Default GET."),
        body: z
          .record(z.any())
          .optional()
          .describe('JSON request body, e.g. {"filter":{},"limit":20,"page":1} for a list endpoint.'),
        confirmWrite: z
          .boolean()
          .optional()
          .describe(
            "Must be true for POST or DELETE. Setting it acknowledges that the path may write — funds-transfer and delete-user are POST/DELETE like any list read.",
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
            `A GET request cannot carry a body. Avito serves its filtered reads (lists, statistics) over POST — ` +
              `re-run "${path}" with method="POST" and confirmWrite=true, or drop the body.`,
          );
        }
        if (!isReadMethod(m) && confirmWrite !== true) {
          return fail(`"${m} ${path}" can write to the account. Re-run with confirmWrite=true to proceed.`);
        }
        return ok(await client.request(m, expandAccountPath(path, client.accountId), body));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
