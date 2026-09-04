/**
 * ADR-010 AI rate-limiting — pure decision logic.
 *
 * Extracted into a side-effect-free `.mjs` module (matching the
 * `add-missing-ingredients-core.mjs` convention) so the quota-exhaustion and
 * fail-open decision paths can be unit-tested directly under `node --test`,
 * without needing a TypeScript/Next.js runtime. `src/lib/ai-quota.ts` is a
 * thin wrapper around this module: it owns the actual `.rpc()` call and the
 * `console.error` alarm side effect; this module only decides what the
 * outcome of a given RPC response means.
 */

/** ADR-010 feature keys — the only AI entry points the quota system covers. */
export const AI_FEATURE_KEYS = {
  RECEIPT_SCAN: "receipt_scan",
  MEAL_PLAN: "meal_plan",
  MEAL_PARSE: "meal_parse",
};

/**
 * Free-tier limit configuration (ADR-010 Rule #4: parameterised
 * configuration, never hard-coded at call-sites). Placeholder defaults
 * pending a product decision; tunable in this one place only.
 */
export const FREE_TIER_AI_LIMITS = {
  [AI_FEATURE_KEYS.RECEIPT_SCAN]: { limit: 20, window: "1 day" },
  [AI_FEATURE_KEYS.MEAL_PLAN]: { limit: 10, window: "1 day" },
  [AI_FEATURE_KEYS.MEAL_PARSE]: { limit: 20, window: "1 day" },
};

/**
 * Maps a raw `{ data, error }` response from the `check_and_consume_ai_quota`
 * RPC call to a quota decision.
 *
 * - RPC error, or a missing/malformed row → fail open (ADR-010 Rule #6):
 *   `{ allowed: true, failedOpen: true, reason, detail }`. The caller is
 *   responsible for logging this loudly; this function has no I/O.
 * - Over limit → `{ allowed: false, retryAfterSeconds, limit }`.
 * - Under limit → `{ allowed: true, failedOpen: false }`.
 *
 * @param {{ data: unknown, error: unknown }} response
 * @param {number} fallbackLimit
 */
export function mapQuotaRpcResponse(response, fallbackLimit) {
  const { data, error } = response;

  if (error) {
    return { allowed: true, failedOpen: true, reason: "rpc_error", detail: error };
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (!row || typeof row !== "object") {
    return { allowed: true, failedOpen: true, reason: "empty_row", detail: row };
  }

  if (!row.allowed) {
    return {
      allowed: false,
      retryAfterSeconds:
        typeof row.retry_after_seconds === "number" ? row.retry_after_seconds : 0,
      limit: typeof row.quota_limit === "number" ? row.quota_limit : fallbackLimit,
    };
  }

  return { allowed: true, failedOpen: false };
}

/**
 * Formats a `retryAfterSeconds` value into a short, user-facing clause.
 *
 * @param {number} retryAfterSeconds
 */
export function formatRetryAfter(retryAfterSeconds) {
  if (retryAfterSeconds <= 60) {
    return "in a minute";
  }

  const minutes = Math.ceil(retryAfterSeconds / 60);

  if (minutes < 60) {
    return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.ceil(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}
