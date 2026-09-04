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

// ---------------------------------------------------------------------------
// 2. Architectural checks: every current Gemini entry point is guarded
// ---------------------------------------------------------------------------

test("receipt scan route consumes receipt_scan quota before any Gemini call", () => {
  const postBody = exportedFunctionBody(scanReceiptRoute, "POST");
  assertQuotaCheckedBeforeGemini(postBody, "POST /api/scan-receipt");
  assert.match(
    postBody,
    /consumeAiQuota\(\s*supabase,\s*AI_FEATURE_KEYS\.RECEIPT_SCAN\s*\)/,
    "receipt scan must use the centrally configured receipt_scan feature key, not a hard-coded limit"
  );
});

test("meal planning (generateMealPlan and replaceMealPlanItem) consumes meal_plan quota before any Gemini call", () => {
  const generateBody = exportedFunctionBody(plannerAction, "generateMealPlan");
  assertQuotaCheckedBeforeGemini(generateBody, "generateMealPlan");
  assert.match(
    generateBody,
    /consumeAiQuota\(\s*supabase,\s*AI_FEATURE_KEYS\.MEAL_PLAN\s*\)/
  );

  const replaceBody = exportedFunctionBody(plannerAction, "replaceMealPlanItem");
  assertQuotaCheckedBeforeGemini(replaceBody, "replaceMealPlanItem");
  assert.match(
    replaceBody,
    /consumeAiQuota\(\s*supabase,\s*AI_FEATURE_KEYS\.MEAL_PLAN\s*\)/,
    "replaceMealPlanItem shares the meal_plan feature key with generateMealPlan"
  );
});

test("meal suggestions (suggestMeals) consumes meal_parse quota before any Gemini call", () => {
  const suggestBody = exportedFunctionBody(mealsAction, "suggestMeals");
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

test("consumeAiQuota fails open and logs loudly when the RPC call errors (ADR-010 Rule #6)", () => {
  assert.match(aiQuotaModule, /failedOpen/);
  assert.match(aiQuotaModule, /console\.error/);
  assert.match(aiQuotaModule, /Rule #6/);
  assert.match(aiQuotaModule, /check_and_consume_ai_quota/);
});
