import "server-only";

import type { createClient } from "@/lib/supabase/server";
import {
  AI_FEATURE_KEYS,
  FREE_TIER_AI_LIMITS,
  formatRetryAfter,
  mapQuotaRpcResponse,
} from "@/lib/ai-quota-core.mjs";

export { AI_FEATURE_KEYS, formatRetryAfter };

export type AiFeatureKey =
  (typeof AI_FEATURE_KEYS)[keyof typeof AI_FEATURE_KEYS];

export type AiQuotaResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; limit: number };

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Must be called, and must succeed with `{ allowed: true }`, before every
 * Gemini provider call (ADR-010 Rule #1). Never inspect or bypass this from
 * the client — enforcement is server-side only (Rule #2), keyed on the
 * authenticated user via `auth.uid()` inside the RPC, never on IP (Rule #3).
 *
 * The actual decision logic (over-limit vs. fail-open vs. allowed) lives in
 * the pure, unit-tested `ai-quota-core.mjs` module; this function's only
 * jobs are making the RPC call with the centrally configured limit/window
 * (Rule #4) and — on the fail-open path (Rule #6) — logging loudly.
 */
export async function consumeAiQuota(
  supabase: SupabaseServerClient,
  feature: AiFeatureKey
): Promise<AiQuotaResult> {
  const config = FREE_TIER_AI_LIMITS[feature];

  const response = await supabase.rpc("check_and_consume_ai_quota", {
    p_feature: feature,
    p_limit: config.limit,
    p_window: config.window,
  });

  const decision = mapQuotaRpcResponse(response, config.limit);

  if (decision.failedOpen) {
    console.error(
      `[consumeAiQuota] check_and_consume_ai_quota failed open for feature "${feature}" (reason: ${decision.reason}) — allowing the AI call per ADR-010 Rule #6:`,
      decision.detail
    );
    return { allowed: true };
  }

  if (!decision.allowed) {
    return {
      allowed: false,
      retryAfterSeconds: decision.retryAfterSeconds,
      limit: decision.limit,
    };
  }

  return { allowed: true };
}
