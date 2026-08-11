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
      title: "Account users",
      annotations: READ_ONLY,
      description:
        "Lists the users with access to the ad account — one {id, role, hasLoggedIn} per user, where role is admin or viewer and hasLoggedIn says whether the invited person has ever signed in. Use the ids with set_user_role and delete_user. Scoped to the configured account: it cannot list the users of a child account. Returns apiPointBalance alongside the data (weekly points left).",
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
      title: "Grant a user access",
      annotations: WRITE,
      description:
        "Grants an existing Avito user access to the ad account with the given role. userId is that person's numeric Avito user id — this tool cannot invite by email or phone, and cannot create an Avito account. If the user already has access, change their role with set_user_role instead. Returns the API's confirmation plus apiPointBalance.",
      inputSchema: {
        userId: entityId().describe("Numeric Avito user id of the person to grant access to, e.g. 94235311."),
        role: userRoleEnum().describe(
          "admin — full access, including users, money transfers and campaign edits; viewer — read-only.",
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
      title: "Change a user's role",
      annotations: WRITE,
      description:
        "Changes the role of a user who already has access to the ad account. Applying the role a user already holds is a no-op. It does not grant access (use add_user) and does not revoke it (use delete_user). Returns the API's confirmation plus apiPointBalance.",
      inputSchema: {
        userId: entityId().describe("Numeric Avito user id, as returned by list_users."),
        role: userRoleEnum().describe(
          "admin — full access, including users, money transfers and campaign edits; viewer — read-only.",
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
      title: "Revoke a user's access",
      annotations: DESTRUCTIVE,
      description:
        "Revokes a user's access to the ad account. Destructive: the only way back is add_user with an explicit role. It does not delete the person's Avito account, their campaigns or their spend history. Returns the API's confirmation plus apiPointBalance.",
      inputSchema: {
        userId: entityId().describe("Numeric Avito user id to remove from the account, as returned by list_users."),
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
