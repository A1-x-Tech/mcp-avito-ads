import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AvitoAdsClient } from "../client.js";
import {
  contractActionEnum,
  contractSubjectEnum,
  contractTypeEnum,
  counterpartyTypeEnum,
  CREATE,
  entityId,
  entityIds,
  fail,
  isoDate,
  legalRoleEnum,
  legalTypeEnum,
  ok,
  pageLimit,
  pageNumber,
  READ_ONLY,
} from "./util.js";

/**
 * ORD paperwork: advertisers and contracts.
 *
 * Russian ad-marking law (ORD) requires every campaign to name a registered
 * advertiser and the contract it runs under, so these four tools are the first
 * step of any campaign setup. Both entities are append-only in this API — there
 * is no edit and no delete endpoint — which is why the creates are annotated as
 * non-idempotent writes and their descriptions say so.
 *
 * The per-type contract rules are NOT re-implemented here: `client.createContract`
 * runs `validateContractInput` and rejects before the request goes out, so the
 * rules live in exactly one place. This module only pins the vocabularies (the
 * zod enums) and the field names.
 */

/**
 * Legal details of a counterparty, as the contract's `intermediary` (contractor)
 * block. Same shape the account and advertiser records use. Extra keys are
 * passed through untouched so a field the SDK does not know about still reaches
 * the API.
 */
const intermediaryDetails = () =>
  z
    .object({
      inn: z.string().min(1).describe("Taxpayer number (INN) of the contractor."),
      shortName: z.string().optional().describe('Short legal name, e.g. "OOO Reklama".'),
      longName: z.string().optional().describe("Full legal name."),
      ogrn: z.string().optional().describe("State registration number (OGRN for a company, OGRNIP for a sole trader)."),
      kpp: z.string().optional().describe("Tax registration reason code (KPP); companies (ul) only."),
      legalAddress: z.string().optional().describe("Registered legal address."),
      actualAddress: z.string().optional().describe("Actual (postal) address."),
      legalType: legalTypeEnum().optional().describe("Legal entity type: ul (company) or ip (sole trader)."),
    })
    .passthrough();

export function registerOrdTools(server: McpServer, client: AvitoAdsClient): void {
  server.registerTool(
    "create_advertiser",
    {
      title: "Register an advertiser (ORD)",
      annotations: CREATE,
      description:
        "Registers an advertiser (an ORD counterparty) under the account and returns {id} plus apiPointBalance (weekly API points left). The id is what campaigns and contracts reference. Legal details must match the state register: inn (10 digits for ul, 12 for ip), ogrn, and both addresses; kpp applies to companies (ul) only. legalRole marks the ORD role — rd (advertiser), ra (agency), rr (distributor). There is no edit or delete endpoint: a wrong advertiser can only be superseded by creating another one, so check list_advertisers for an existing record first.",
      inputSchema: {
        inn: z
          .string()
          .min(1)
          .describe("Taxpayer number (INN): 10 digits for a company (ul), 12 for a sole trader (ip)."),
        shortName: z.string().min(1).describe('Short legal name, e.g. "OOO Reklama".'),
        longName: z
          .string()
          .min(1)
          .describe('Full legal name, e.g. "Obshchestvo s ogranichennoy otvetstvennostyu Reklama".'),
        ogrn: z.string().min(1).describe("State registration number (OGRN for ul, OGRNIP for ip)."),
        legalAddress: z.string().min(1).describe("Registered legal address."),
        actualAddress: z.string().min(1).describe("Actual (postal) address; repeat legalAddress if they match."),
        legalRole: legalRoleEnum().describe(
          "ORD role of the counterparty: rd (advertiser), ra (agency), rr (distributor).",
        ),
        legalType: legalTypeEnum().describe("Legal entity type: ul (company) or ip (sole trader)."),
        kpp: z.string().optional().describe("Tax registration reason code (KPP). Companies (ul) only; omit for ip."),
      },
    },
    async ({ inn, shortName, longName, ogrn, legalAddress, actualAddress, legalRole, legalType, kpp }) => {
      try {
        return ok(
          await client.createAdvertiser({
            inn,
            shortName,
            longName,
            ogrn,
            legalAddress,
            actualAddress,
            legalRole,
            legalType,
            kpp,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_advertisers",
    {
      title: "List advertisers",
      annotations: READ_ONLY,
      description:
        "Returns one page of advertisers registered under the account: {total, items, page, limit, hasNextPage} plus apiPointBalance (weekly API points left). Each item carries id, shortName, longName, inn, ogrn, kpp, legalAddress, actualAddress, legalType (ul|ip) and legalRole (rd|ra|rr). Narrow the page with filter.ids / filter.inns / filter.roles; there is no free-text search, so match on names yourself. limit is 1..100 (default 20); page is 1-based.",
      inputSchema: {
        filter: z
          .object({
            ids: entityIds().optional().describe("Only these advertiser ids."),
            inns: z.array(z.string()).optional().describe("Only advertisers with these taxpayer numbers (INN)."),
            roles: z
              .array(legalRoleEnum())
              .optional()
              .describe("Only these ORD roles: rd (advertiser), ra (agency), rr (distributor)."),
          })
          .passthrough()
          .optional()
          .describe("Filter for the page. Omit for all advertisers."),
        limit: pageLimit().optional().describe("Page size, 1..100. Default 20."),
        page: pageNumber().optional().describe("1-based page number. Default 1."),
      },
    },
    async ({ filter, limit, page }) => {
      try {
        return ok(await client.listAdvertisers({ filter, limit, page }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_contract",
    {
      title: "Register a contract (ORD)",
      annotations: CREATE,
      description:
        "Registers an ORD contract between the account and an advertiser and returns {id} plus apiPointBalance (weekly API points left). Which fields are mandatory depends on type: service needs subject, isReportingRequired, date and number (cid is rejected); intermediary needs all of those plus object and isFundsAllocationToPrincipal (cid is rejected); external needs cid only (parentId is rejected). Pass the contractor's legal details in intermediary — required unless parentId is set; with parentId the record is an additional agreement to that contract and must omit intermediary. There is no edit or delete endpoint, so a wrong contract stays on the account forever.",
      inputSchema: {
        advertiserId: entityId().describe("Advertiser this contract is with (the client). From list_advertisers."),
        type: contractTypeEnum().describe(
          "Contract type: service (services rendered), intermediary (mediation), external (concluded outside Avito, identified by cid).",
        ),
        counterpartyType: counterpartyTypeEnum().describe(
          "Counterparty type — sent as the API's `description` field: direct_with_advertiser or advertiser_intermediary.",
        ),
        subject: contractSubjectEnum()
          .optional()
          .describe(
            "Contract subject: org-distribution, mediation, distribution, representation, other. Required for service and intermediary.",
          ),
        object: contractActionEnum()
          .optional()
          .describe(
            "Contract action, the API's `object` field: distribution, conclude, commercial, other. Required for intermediary.",
          ),
        cid: z
          .string()
          .min(1)
          .optional()
          .describe("External contract id (ERID-side identifier). Required for type external, rejected for the others."),
        date: isoDate().optional().describe("Contract date, YYYY-MM-DD. Required for service and intermediary."),
        number: z.string().min(1).optional().describe("Contract number. Required for service and intermediary."),
        isReportingRequired: z
          .boolean()
          .optional()
          .describe("Whether acts/reports are required under the contract. Required for service and intermediary."),
        isFundsAllocationToPrincipal: z
          .boolean()
          .optional()
          .describe("Whether funds are allocated to the principal. Required for intermediary."),
        parentId: entityId()
          .optional()
          .describe("Parent contract id. Set it to register an additional agreement; then omit intermediary."),
        intermediary: intermediaryDetails()
          .optional()
          .describe("Legal details of the contractor (the intermediary). Required unless parentId is set."),
      },
    },
    async ({
      advertiserId,
      type,
      counterpartyType,
      subject,
      object,
      cid,
      date,
      number,
      isReportingRequired,
      isFundsAllocationToPrincipal,
      parentId,
      intermediary,
    }) => {
      try {
        return ok(
          await client.createContract({
            advertiserId,
            type,
            // The API names the counterparty type `description`; the tool takes
            // the SDK builder's clearer name and renames it here.
            description: counterpartyType,
            subject,
            object,
            cid,
            date,
            number,
            isReportingRequired,
            isFundsAllocationToPrincipal,
            parentId,
            intermediary,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_contracts",
    {
      title: "List contracts",
      annotations: READ_ONLY,
      description:
        "Returns one page of contracts registered under the account: {total, items, page, limit, hasNextPage} plus apiPointBalance (weekly API points left). Each item carries id, type, number, date, subject, object (the contract action), cid, description (the counterparty type), parentId (set on additional agreements) and the client/contractor legal details. Narrow the page with filter.ids / filter.numbers / filter.clients (advertiser ids) / filter.contractors. limit is 1..100 (default 20); page is 1-based.",
      inputSchema: {
        filter: z
          .object({
            ids: entityIds().optional().describe("Only these contract ids."),
            numbers: z.array(z.string()).optional().describe("Only contracts with these contract numbers."),
            clients: entityIds().optional().describe("Only contracts whose client is one of these advertiser ids."),
            contractors: entityIds().optional().describe("Only contracts with these contractor (intermediary) ids."),
          })
          .passthrough()
          .optional()
          .describe("Filter for the page. Omit for all contracts."),
        limit: pageLimit().optional().describe("Page size, 1..100. Default 20."),
        page: pageNumber().optional().describe("1-based page number. Default 1."),
      },
    },
    async ({ filter, limit, page }) => {
      try {
        return ok(await client.listContracts({ filter, limit, page }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
