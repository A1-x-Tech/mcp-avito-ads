import { test } from "node:test";
import assert from "node:assert/strict";

import { AvitoAdsError } from "../types.js";
import {
  CREATE,
  DESTRUCTIVE,
  entityId,
  fail,
  filterObject,
  isoDate,
  ok,
  pageLimit,
  pageNumber,
  READ_ONLY,
  rubleAmount,
  userRoleEnum,
  WRITE,
} from "./util.js";

test("isoDate accepts YYYY-MM-DD and rejects timestamps and junk", () => {
  const d = isoDate(); // factory → fresh schema
  assert.equal(d.safeParse("2026-01-31").success, true);
  assert.equal(d.safeParse("2026-01-31T00:00:00Z").success, false);
  assert.equal(d.safeParse("31.01.2026").success, false);
  assert.equal(d.safeParse("yesterday").success, false);
});

test("the schema helpers are factories returning independent schemas", () => {
  // A shared const would make zod-to-json-schema collapse two fields into a $ref.
  assert.notEqual(isoDate(), isoDate());
  assert.notEqual(pageLimit(), pageLimit());
  assert.notEqual(userRoleEnum(), userRoleEnum());
});

test("pageLimit mirrors the API's 1..100 bound and rejects fractions", () => {
  const limit = pageLimit();
  assert.equal(limit.safeParse(1).success, true);
  assert.equal(limit.safeParse(100).success, true);
  assert.equal(limit.safeParse(0).success, false);
  assert.equal(limit.safeParse(101).success, false);
  assert.equal(limit.safeParse(10.5).success, false);
  assert.equal(pageNumber().safeParse(0).success, false);
  assert.equal(pageNumber().safeParse(3).success, true);
});

test("entityId and rubleAmount enforce the API's minimums", () => {
  assert.equal(entityId().safeParse(0).success, false);
  assert.equal(entityId().safeParse(-1).success, false);
  assert.equal(entityId().safeParse(42).success, true);
  assert.equal(rubleAmount().safeParse(0.5).success, false);
  assert.equal(rubleAmount().safeParse(1).success, true);
});

test("userRoleEnum is exactly the roles the API accepts", () => {
  assert.deepEqual(userRoleEnum().options, ["admin", "viewer"]);
  assert.equal(userRoleEnum().safeParse("owner").success, false);
});

test("filterObject passes an arbitrary filter through", () => {
  assert.equal(filterObject().safeParse({ statuses: ["active"], ids: [1, 2] }).success, true);
  assert.equal(filterObject().safeParse("active").success, false);
});

test("ok emits compact JSON; fail flags isError", () => {
  assert.equal((ok({ a: 1 }).content[0] as { text: string }).text, '{"a":1}');
  const f = fail(new Error("boom"));
  assert.equal(f.isError, true);
  assert.match((f.content[0] as { text: string }).text, /boom/);
});

test("ok passes a client envelope through, point balance included", () => {
  const text = (ok({ data: { total: 2 }, apiPointBalance: 4832 }).content[0] as { text: string }).text;
  assert.equal(text, '{"data":{"total":2},"apiPointBalance":4832}');
});

test("fail appends the underlying cause when present", () => {
  const err = new Error("timeout", { cause: new Error("ECONNRESET") });
  const f = fail(err);
  assert.match((f.content[0] as { text: string }).text, /timeout \(ECONNRESET\)/);
});

test("fail surfaces Retry-After and the point balance of a rate-limited call", () => {
  // A 429 is the error this weekly-metered API is built around: without these
  // two numbers the agent cannot tell when — or whether — to come back.
  const err = new AvitoAdsError(429, { message: "weekly quota spent" }, undefined, {
    retryAfter: 3600,
    apiPointBalance: 0,
  });
  const text = (fail(err).content[0] as { text: string }).text;
  assert.match(text, /retry after 3600s/);
  assert.match(text, /apiPointBalance: 0/);
});

test("fail adds nothing when the API sent neither number", () => {
  const text = (fail(new AvitoAdsError(400, { message: "bad request" })).content[0] as { text: string }).text;
  assert.equal(text, "Error: HTTP 400: bad request");
});

test("every annotation sets all four hints", () => {
  assert.deepEqual(READ_ONLY, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(WRITE, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(CREATE, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(DESTRUCTIVE, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});
