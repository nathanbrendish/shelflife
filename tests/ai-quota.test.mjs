// ADR-010 AI rate-limiting + usage metering — unit-level proof.
//
// Two layers are tested here (dependency-free, no live DB — see
// tests-integration/ai-quota.test.mjs for the real-RPC proof):
//
//   1. The pure decision logic in ai-quota-core.mjs: over-limit mapping and
//      the fail-open path (ADR-010 Rule #6), tested directly since it is a
//      plain .mjs module (same convention as add-missing-ingredients-core.mjs).
//   2. Architectural/static checks on the three AI entry points, proving
//      each one calls the shared `consumeAiQuota()` helper — using its
//      centrally configured feature key, never a hard-coded limit — before
//      constructing a Gemini client (ADR-010 Rule #1 and Rule #4).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AI_FEATURE_KEYS,
  FREE_TIER_AI_LIMITS,
  formatRetryAfter,
  isDateBinCompatibleWindow,
  mapQuotaRpcResponse,
} from "../src/lib/ai-quota-core.mjs";

const aiQuotaModule = readFileSync(
  new URL("../src/lib/ai-quota.ts", import.meta.url),
  "utf8"
);
const scanReceiptRoute = readFileSync(
  new URL("../src/app/api/scan-receipt/route.ts", import.meta.url),
  "utf8"
);
const plannerAction = readFileSync(
  new URL("../src/app/actions/planner.ts", import.meta.url),
  "utf8"
);
const mealsAction = readFileSync(
  new URL("../src/app/actions/meals.ts", import.meta.url),
  "utf8"
);

function exportedFunctionBody(source, functionName) {
  const start = source.indexOf(`export async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);

  const braceStart = source.indexOf("{", start);
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);

  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
    }
  }
  throw new Error(`Could not find end of ${functionName} body`);
}

/** Asserts the quota check happens strictly before any Gemini client setup. */
function assertQuotaCheckedBeforeGemini(body, label) {
  const quotaIndex = body.indexOf("consumeAiQuota(");
  const geminiIndex = body.indexOf("new GoogleGenerativeAI(");

  assert.notEqual(quotaIndex, -1, `${label} should call consumeAiQuota`);
  assert.notEqual(geminiIndex, -1, `${label} should construct a Gemini client`);
  assert.ok(
    quotaIndex < geminiIndex,
    `${label} must check quota before constructing the Gemini client`
  );

  const between = body.slice(quotaIndex, geminiIndex);
  assert.match(
    between,
    /if\s*\(\s*!quota\.allowed\s*\)/,
    `${label} must branch on an unsuccessful quota consume`
  );
  assert.match(
    between,
    /return/,
    `${label} must short-circuit (return) before reaching the Gemini client on over-quota`
  );
}

// ---------------------------------------------------------------------------
// 1. Pure decision logic
// ---------------------------------------------------------------------------

test("mapQuotaRpcResponse: allows a request under the limit", () => {
  const result = mapQuotaRpcResponse(
    {
      data: { allowed: true, current_count: 3, quota_limit: 20, retry_after_seconds: 0 },
      error: null,
    },
    20
  );
  assert.deepEqual(result, { allowed: true, failedOpen: false });
});

test("mapQuotaRpcResponse: unwraps a PostgREST array-of-rows response (RETURNS TABLE)", () => {
  const result = mapQuotaRpcResponse(
    {
      data: [{ allowed: true, current_count: 1, quota_limit: 20, retry_after_seconds: 0 }],
      error: null,
    },
    20
  );
  assert.equal(result.allowed, true);
});

test("mapQuotaRpcResponse: blocks an over-limit request with a positive retry-after and the real limit", () => {
  const result = mapQuotaRpcResponse(
    {
      data: {
        allowed: false,
        current_count: 21,
        quota_limit: 20,
        retry_after_seconds: 3600,
      },
      error: null,
    },
    20
  );
  assert.deepEqual(result, {
    allowed: false,
    retryAfterSeconds: 3600,
    limit: 20,
  });
});

test("mapQuotaRpcResponse: fails open (ADR-010 Rule #6) when the RPC itself errors", () => {
  const rpcError = { message: "connection reset" };
  const result = mapQuotaRpcResponse({ data: null, error: rpcError }, 20);
  assert.equal(result.allowed, true);
  assert.equal(result.failedOpen, true);
  assert.equal(result.reason, "rpc_error");
  assert.equal(result.detail, rpcError);
});

test("mapQuotaRpcResponse: fails open when the RPC returns no usable row", () => {
  const emptyArray = mapQuotaRpcResponse({ data: [], error: null }, 20);
  assert.equal(emptyArray.allowed, true);
  assert.equal(emptyArray.failedOpen, true);
  assert.equal(emptyArray.reason, "empty_row");

  const nullData = mapQuotaRpcResponse({ data: null, error: null }, 20);
  assert.equal(nullData.allowed, true);
  assert.equal(nullData.failedOpen, true);
  assert.equal(nullData.reason, "empty_row");
});

// ---------------------------------------------------------------------------
// FF-1: a present-but-malformed row fails OPEN (like any other malformed
// response), not closed. Before this fix, a row missing `allowed` (e.g.
// `{}`) fell through to `!row.allowed` and was misread as a real deny.
// ---------------------------------------------------------------------------

test("mapQuotaRpcResponse (FF-1): a row missing `allowed` fails open, not closed", () => {
  const missingField = mapQuotaRpcResponse({ data: { current_count: 1 }, error: null }, 20);
  assert.equal(missingField.allowed, true, "a malformed row must never be read as a real deny");
  assert.equal(missingField.failedOpen, true);
  assert.equal(missingField.reason, "malformed_row");
});

test("mapQuotaRpcResponse (FF-1): a row with a non-boolean `allowed` fails open", () => {
  for (const badValue of [undefined, null, 0, "", "true", 1]) {
    const result = mapQuotaRpcResponse({ data: { allowed: badValue }, error: null }, 20);
    assert.equal(
      result.allowed,
      true,
      `allowed: ${JSON.stringify(badValue)} is malformed input, not a real deny — must fail open`
    );
    assert.equal(result.failedOpen, true);
    assert.equal(result.reason, "malformed_row");
  }
});

test("mapQuotaRpcResponse (FF-1): a real `allowed === false` on a well-formed row still denies", () => {
  const result = mapQuotaRpcResponse(
    { data: { allowed: false, retry_after_seconds: 120, quota_limit: 20 }, error: null },
    20
  );
  assert.deepEqual(result, { allowed: false, retryAfterSeconds: 120, limit: 20 });
});

// ---------------------------------------------------------------------------
// FF-2: an auth-class RPC error fails CLOSED (never grants an
// unauthenticated caller a free AI call via the Rule #6 fail-open path),
// while a genuine transient/infra error still fails open.
// ---------------------------------------------------------------------------

test("mapQuotaRpcResponse (FF-2): a permission-denied (42501) error — an anonymous caller rejected by PostgREST's GRANT — fails closed", () => {
  const permissionDenied = {
    code: "42501",
    message: 'permission denied for function check_and_consume_ai_quota',
  };
  const result = mapQuotaRpcResponse({ data: null, error: permissionDenied }, 20);
  assert.equal(result.allowed, false, "an unauthenticated caller must be denied, never fail open");
  assert.equal(result.authDenied, true);
  assert.notEqual(result.failedOpen, true, "an auth-class denial is not the generic fail-open path");
});

test("mapQuotaRpcResponse (FF-2): the RPC's own \"Not authenticated\" auth.uid() guard also fails closed", () => {
  const notAuthenticated = { message: "Not authenticated" };
  const result = mapQuotaRpcResponse({ data: null, error: notAuthenticated }, 20);
  assert.equal(result.allowed, false);
  assert.equal(result.authDenied, true);
});

test("mapQuotaRpcResponse (FF-2): a real transient/infra RPC error is NOT treated as auth-class and still fails open (Rule #6)", () => {
  const timeout = { code: "ETIMEDOUT", message: "connection timeout" };
  const result = mapQuotaRpcResponse({ data: null, error: timeout }, 20);
  assert.equal(result.allowed, true, "a genuine infra failure must still fail open per Rule #6");
  assert.equal(result.failedOpen, true);
  assert.equal(result.reason, "rpc_error");
  assert.notEqual(
    result.authDenied,
    true,
    "a transient error must not be misclassified as an auth-class denial"
  );
});

test("mapQuotaRpcResponse (FF-2): an unrelated error whose message happens to contain other words is not misclassified as auth-class", () => {
  const unrelated = { message: "duplicate key value violates unique constraint" };
  const result = mapQuotaRpcResponse({ data: null, error: unrelated }, 20);
  assert.equal(result.allowed, true);
  assert.equal(result.failedOpen, true);
  assert.notEqual(result.authDenied, true);
});

test("mapQuotaRpcResponse (FF-2 nit): message-text matching is exact equality, not a substring check", () => {
  // Proves the `.includes()` -> `===` tightening actually took effect: a
  // message that merely CONTAINS "Not authenticated" inside unrelated text
  // (e.g. an RLS error quoting it) must NOT be misclassified as the RPC's
  // own auth.uid() guard failure — it falls through to the generic
  // transient/infra fail-open path instead.
  const containsButNotEqual = {
    message: "Not authenticated to view this row (RLS policy violation)",
  };
  const result = mapQuotaRpcResponse({ data: null, error: containsButNotEqual }, 20);
  assert.equal(
    result.allowed,
    true,
    "a message that only contains the auth-guard text, but isn't an exact match, must fail open, not closed"
  );
  assert.equal(result.failedOpen, true);
  assert.notEqual(result.authDenied, true);

  // The exact string still matches (unchanged behaviour).
  const exact = mapQuotaRpcResponse({ data: null, error: { message: "Not authenticated" } }, 20);
  assert.equal(exact.allowed, false);
  assert.equal(exact.authDenied, true);
});

// ---------------------------------------------------------------------------
// N-2: every configured window must be date_bin-compatible (no month/year
// components — Postgres rejects those strides outright).
// ---------------------------------------------------------------------------

test("isDateBinCompatibleWindow (N-2): rejects month/year strides (written-out and abbreviated) and accepts day/hour/minute/second strides", () => {
  // Prove the check actually catches a bad window, not just rubber-stamping.
  assert.equal(isDateBinCompatibleWindow("1 month"), false);
  assert.equal(isDateBinCompatibleWindow("1 year"), false);
  assert.equal(isDateBinCompatibleWindow("2 months 3 days"), false);
  assert.equal(isDateBinCompatibleWindow("1 YEAR"), false, "must be case-insensitive");

  // Postgres's abbreviated interval spellings — a bare word check misses
  // these unless it also handles the no-space digit-unit form.
  assert.equal(isDateBinCompatibleWindow("1 mon"), false);
  assert.equal(isDateBinCompatibleWindow("2 mons"), false);
  assert.equal(isDateBinCompatibleWindow("3 y"), false);
  assert.equal(isDateBinCompatibleWindow("5 yr"), false);
  assert.equal(isDateBinCompatibleWindow("5 yrs"), false);
  assert.equal(isDateBinCompatibleWindow("1mon"), false, "no-space digit-unit form");
  assert.equal(isDateBinCompatibleWindow("3y"), false, "no-space digit-unit form");
  assert.equal(isDateBinCompatibleWindow("5yrs"), false, "no-space digit-unit form");

  assert.equal(isDateBinCompatibleWindow("1 day"), true);
  assert.equal(isDateBinCompatibleWindow("12 hours"), true);
  assert.equal(isDateBinCompatibleWindow("30 minutes"), true);
  assert.equal(isDateBinCompatibleWindow("1 week"), true);
  assert.equal(isDateBinCompatibleWindow("7 days"), true);
  // "day" ends in "y" and "may"-like words must not false-positive: the
  // heuristic only fires when the unit token isn't itself glued to other
  // letters (a preceding/following letter, as opposed to a digit or space).
  assert.equal(isDateBinCompatibleWindow("1 day"), true, "must not false-positive on the trailing 'y' in 'day'");
});

test("every FREE_TIER_AI_LIMITS window is date_bin-compatible (N-2 config guard)", () => {
  for (const key of Object.values(AI_FEATURE_KEYS)) {
    const config = FREE_TIER_AI_LIMITS[key];
    assert.ok(
      isDateBinCompatibleWindow(config.window),
      `"${config.window}" for "${key}" would break date_bin at the RPC (month/year strides are rejected by Postgres)`
    );
  }
});

test("formatRetryAfter: renders short, medium, and long windows sensibly", () => {
  assert.equal(formatRetryAfter(30), "in a minute");
  assert.equal(formatRetryAfter(90), "in about 2 minutes");
  assert.equal(formatRetryAfter(60), "in a minute");
  assert.equal(formatRetryAfter(3600), "in about 1 hour");
  assert.equal(formatRetryAfter(7200), "in about 2 hours");
});

test("free-tier limit config covers exactly the three ADR-010 feature keys, with no hard-coded call-site limits", () => {
  const keys = Object.values(AI_FEATURE_KEYS);
  assert.deepEqual(new Set(keys), new Set(["receipt_scan", "meal_plan", "meal_parse"]));

  for (const key of keys) {
    const config = FREE_TIER_AI_LIMITS[key];
    assert.ok(config, `FREE_TIER_AI_LIMITS must define a limit for "${key}"`);
    assert.equal(typeof config.limit, "number");
    assert.ok(config.limit > 0);
    assert.equal(typeof config.window, "string");
  }
});

/**
 * FF-2's "auth precedes quota" invariant: every AI entry point must resolve
 * the caller's identity — via an explicit `auth.getUser()` call, the shared
 * `getAuthenticatedUser()` helper (planner.ts), or `getPantryForMeals()`
 * (meals.ts), which itself calls `auth.getUser()` and redirects an
 * unauthenticated caller before ever returning — strictly before calling
 * `consumeAiQuota(`. This is defense-in-depth alongside FF-2's RPC-level
 * auth-class fail-closed behaviour (see ai-quota-core.mjs): no entry point
 * should ever be relying on the quota RPC as its *only* authentication
 * gate. This test fails if a future entry point (or a refactor of an
 * existing one) calls consumeAiQuota before any of these markers appear.
 */
function assertAuthResolvedBeforeQuota(body, label) {
  const quotaIndex = body.indexOf("consumeAiQuota(");
  assert.notEqual(quotaIndex, -1, `${label} should call consumeAiQuota`);

  const authMarkers = ["auth.getUser(", "getAuthenticatedUser(", "getPantryForMeals("];
  const authIndexes = authMarkers
    .map((marker) => body.indexOf(marker))
    .filter((index) => index !== -1);

  assert.ok(
    authIndexes.length > 0,
    `${label} must resolve the caller's identity (auth.getUser() / getAuthenticatedUser() / getPantryForMeals()) somewhere in its body before consuming quota`
  );
  assert.ok(
    Math.min(...authIndexes) < quotaIndex,
    `${label} must authenticate the caller before calling consumeAiQuota — never let the quota RPC be the only auth gate`
  );
}

// ---------------------------------------------------------------------------
// 2. Architectural checks: every current Gemini entry point is guarded
// ---------------------------------------------------------------------------

test("receipt scan route consumes receipt_scan quota before any Gemini call", () => {
  const postBody = exportedFunctionBody(scanReceiptRoute, "POST");
  assertAuthResolvedBeforeQuota(postBody, "POST /api/scan-receipt");
  assertQuotaCheckedBeforeGemini(postBody, "POST /api/scan-receipt");
  assert.match(
    postBody,
    /consumeAiQuota\(\s*supabase,\s*AI_FEATURE_KEYS\.RECEIPT_SCAN\s*\)/,
    "receipt scan must use the centrally configured receipt_scan feature key, not a hard-coded limit"
  );
});

test("meal planning (generateMealPlan and replaceMealPlanItem) consumes meal_plan quota before any Gemini call", () => {
  const generateBody = exportedFunctionBody(plannerAction, "generateMealPlan");
  assertAuthResolvedBeforeQuota(generateBody, "generateMealPlan");
  assertQuotaCheckedBeforeGemini(generateBody, "generateMealPlan");
  assert.match(
    generateBody,
    /consumeAiQuota\(\s*supabase,\s*AI_FEATURE_KEYS\.MEAL_PLAN\s*\)/
  );

  const replaceBody = exportedFunctionBody(plannerAction, "replaceMealPlanItem");
  assertAuthResolvedBeforeQuota(replaceBody, "replaceMealPlanItem");
  assertQuotaCheckedBeforeGemini(replaceBody, "replaceMealPlanItem");
  assert.match(
    replaceBody,
    /consumeAiQuota\(\s*supabase,\s*AI_FEATURE_KEYS\.MEAL_PLAN\s*\)/,
    "replaceMealPlanItem shares the meal_plan feature key with generateMealPlan"
  );
});

test("meal suggestions (suggestMeals) consumes meal_parse quota before any Gemini call", () => {
  const suggestBody = exportedFunctionBody(mealsAction, "suggestMeals");
  assertAuthResolvedBeforeQuota(suggestBody, "suggestMeals");
  assertQuotaCheckedBeforeGemini(suggestBody, "suggestMeals");
  assert.match(
    suggestBody,
    /consumeAiQuota\(\s*supabase,\s*AI_FEATURE_KEYS\.MEAL_PARSE\s*\)/
  );

  // The deterministic catalogue path must stay Gemini-free and therefore
  // quota-free — it would be a real bug for it to consume budget.
  const catalogueBody = exportedFunctionBody(mealsAction, "getCatalogueMealSuggestions");
  assert.doesNotMatch(catalogueBody, /consumeAiQuota|GoogleGenerativeAI/);
});

test("FF-2 invariant is not vacuous: an entry point calling consumeAiQuota before authenticating would fail", () => {
  const unauthenticatedFirst = `
    export async function fakeEntryPoint() {
      const quota = await consumeAiQuota(supabase, AI_FEATURE_KEYS.MEAL_PARSE);
      const { data: { user } } = await supabase.auth.getUser();
    }
  `;
  assert.throws(
    () => assertAuthResolvedBeforeQuota(unauthenticatedFirst, "fakeEntryPoint"),
    /must authenticate the caller before calling consumeAiQuota/
  );

  const noAuthAtAll = `
    export async function fakeEntryPoint() {
      const quota = await consumeAiQuota(supabase, AI_FEATURE_KEYS.MEAL_PARSE);
    }
  `;
  assert.throws(
    () => assertAuthResolvedBeforeQuota(noAuthAtAll, "fakeEntryPoint"),
    /must resolve the caller's identity/
  );
});

test("consumeAiQuota fails open and logs loudly when the RPC call errors (ADR-010 Rule #6)", () => {
  assert.match(aiQuotaModule, /failedOpen/);
  assert.match(aiQuotaModule, /console\.error/);
  assert.match(aiQuotaModule, /Rule #6/);
  assert.match(aiQuotaModule, /check_and_consume_ai_quota/);
});
