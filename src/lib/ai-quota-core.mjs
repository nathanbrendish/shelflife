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
 * FF-2: recognizes an "auth-class" RPC error — the caller was never a
 * genuinely authenticated user, as opposed to a transient/infra failure
 * (timeout, connection reset, function temporarily unavailable, etc.).
 * This distinction matters because ADR-010 Rule #6's fail-open exists to
 * absorb infra hiccups, not to become an authentication bypass: an
 * unauthenticated caller must never ride the fail-open path into a free,
 * unmetered AI call.
 *
 * Two structurally distinct signals, both producible by this exact RPC:
 *
 *  - SQLSTATE `42501` ("permission denied for function") — PostgREST
 *    rejects the call before the function body ever runs, because
 *    migration 016's `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO
 *    authenticated` means only the `authenticated` role has EXECUTE. A
 *    genuinely anonymous caller hits this. This is a real, structured
 *    Postgres error code, not string matching.
 *  - The literal text "Not authenticated" — migration 016's own
 *    `IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'` guard
 *    (016:163-165), the RPC's first statement (defense-in-depth for an
 *    `authenticated`-role JWT that somehow still resolves no uid — see the
 *    "requires authentication" case in tests-integration/ai-quota.test.mjs,
 *    which exercises exactly this path over a direct DB connection that
 *    bypasses PostgREST's role grants). A plain `RAISE EXCEPTION 'text'`
 *    with no `USING ERRCODE` always reports the generic SQLSTATE `P0001`
 *    — shared by every other RAISE EXCEPTION in this function (invalid
 *    feature/limit/window) — so SQLSTATE alone can't distinguish it. Exact
 *    message-text equality is the only signal available without editing
 *    the RPC, and migration 016 is already deployed (ADR-008 immutability
 *    rules out editing it here). This is a deliberate, narrow coupling to
 *    that exact string — checked with `===`, not a substring/`.includes()`
 *    match, so an unrelated error that merely mentions "Not authenticated"
 *    inside a longer message is never misclassified: if the RPC's wording
 *    ever changes, this specific defense-in-depth case silently reverts to
 *    fail-open — the `42501` path above is unaffected and remains robust
 *    regardless.
 *
 * @param {unknown} error
 */
function isAuthClassError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (error.code === "42501") {
    return true;
  }

  return error.message === "Not authenticated";
}

/**
 * `date_bin(stride, ...)` — used by migration 016's
 * `check_and_consume_ai_quota` to bucket usage windows — rejects any stride
 * interval containing a month or year component; Postgres raises
 * "timestamps cannot be binned into intervals containing months or years"
 * for those. Every configured window must therefore be expressible in
 * days/hours/minutes/seconds only.
 *
 * This is a heuristic config-validation guard, NOT a full Postgres interval
 * parser: it rejects the written-out words ("month"/"year", singular or
 * plural) and their common abbreviations ("mon"/"mons", "y"/"yr"/"yrs"),
 * including Postgres's no-space digit-unit form (e.g. "1mon", "3y") — the
 * lookbehind/lookahead below use "not preceded/followed by a letter" rather
 * than `\b`, since `\b` never fires between a digit and a letter, and
 * Postgres accepts interval literals with no space between the two. It is
 * NOT exhaustive against every interval spelling Postgres accepts (e.g.
 * ISO 8601 duration syntax); it exists to catch what a developer would
 * plausibly type into `FREE_TIER_AI_LIMITS`, cheaply, in a unit test, long
 * before it ever reaches the RPC in production.
 *
 * @param {unknown} window
 */
export function isDateBinCompatibleWindow(window) {
  return (
    typeof window === "string" &&
    !/(?<![a-z])(years?|yrs?|y|months?|mons?)(?![a-z])/i.test(window)
  );
}

/**
 * Maps a raw `{ data, error }` response from the `check_and_consume_ai_quota`
 * RPC call to a quota decision.
 *
 * - Auth-class RPC error (FF-2, see `isAuthClassError` above) → fail
 *   CLOSED: `{ allowed: false, retryAfterSeconds: 0, limit, authDenied: true }`.
 *   Never grants an unauthenticated caller a free AI call.
 * - Any other RPC error, or a missing/malformed row → fail open (ADR-010
 *   Rule #6): `{ allowed: true, failedOpen: true, reason, detail }`. The
 *   caller is responsible for logging this loudly; this function has no I/O.
 * - A present row whose `allowed` field isn't a boolean (FF-1: the RPC's
 *   output contract broke, not a real deny) → fails open the same as a
 *   missing row: `{ allowed: true, failedOpen: true, reason: "malformed_row", detail }`.
 * - Over limit (well-formed row, `allowed === false`) → `{ allowed: false, retryAfterSeconds, limit }`.
 * - Under limit → `{ allowed: true, failedOpen: false }`.
 *
 * @param {{ data: unknown, error: unknown }} response
 * @param {number} fallbackLimit
 */
export function mapQuotaRpcResponse(response, fallbackLimit) {
  const { data, error } = response;

  if (error) {
    if (isAuthClassError(error)) {
      return {
        allowed: false,
        retryAfterSeconds: 0,
        limit: fallbackLimit,
        authDenied: true,
      };
    }

    return { allowed: true, failedOpen: true, reason: "rpc_error", detail: error };
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (!row || typeof row !== "object") {
    return { allowed: true, failedOpen: true, reason: "empty_row", detail: row };
  }

  // FF-1: a row that is present but malformed (missing/non-boolean
  // `allowed`) must fail OPEN like any other malformed response — it means
  // the RPC's output contract broke, not that the request was denied by the
  // RPC's own logic. Only a genuine `allowed === false` on a well-formed row
  // (checked below) is a real deny. This check must run before the
  // `!row.allowed` branch below, since `!undefined` is also truthy-false and
  // would otherwise be misread as a real denial.
  if (typeof row.allowed !== "boolean") {
    return { allowed: true, failedOpen: true, reason: "malformed_row", detail: row };
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
