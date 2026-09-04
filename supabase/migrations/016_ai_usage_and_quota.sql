-- AI rate-limiting and usage metering (ADR-010)
--
-- Every Gemini call in the app (receipt scan, meal planning, meal parsing)
-- currently has no per-user ceiling and no usage record - the only backstop
-- is the provider's own 429. This migration adds the durable Postgres store
-- and the atomic SECURITY DEFINER RPC that ADR-010 requires every AI entry
-- point to call, successfully, before making a provider call.
--
-- This migration is purely additive: two new tables, one new RPC, and their
-- RLS policies. Nothing in migrations 001-015 is edited (immutable, per
-- ADR-008 section 11.6), and none of the ADR-009 transactional-write RPCs
-- are touched.
--
-- Two tables, matching the ADR-010 canonical pattern's two responsibilities:
--   - ai_usage_counters - the atomic, per-(user, feature, fixed window)
--     counter that enforcement checks against. One row per window; updated
--     in place via ON CONFLICT ... DO UPDATE so concurrent requests from
--     the same user cannot both read count N and both proceed to N+1.
--   - ai_usage_log - an append-only per-call record for metering. Only a
--     row for a call that is actually ALLOWED to reach Gemini is inserted
--     here (a blocked attempt never happens against the provider, so it
--     isn't "usage"). size_estimate is included per the ADR's
--     implementation notes as metering-ready schema; no current call site
--     has a natural token/size figure to pass, so the RPC signature matches
--     ADR-010 exactly (p_feature, p_limit, p_window - no size parameter)
--     and this column is populated as NULL for now. A future call site with
--     a real estimate can extend the RPC in its own reviewed change; this
--     is a deliberate, documented scope boundary, not a gap.

-- =============================================================================
-- Tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ai_usage_counters (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature, window_start)
);

CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  size_estimate integer
);

CREATE INDEX IF NOT EXISTS ai_usage_log_user_feature_idx
  ON public.ai_usage_log (user_id, feature, created_at);

-- =============================================================================
-- RLS (ADR-010 Rule #5: usage rows are RLS-protected - a user reads only
-- their own usage; service/admin roles read all for metering. No client
-- INSERT/UPDATE/DELETE policy exists on either table: the only writer is
-- the SECURITY DEFINER RPC below, which writes as the function owner and so
-- is unaffected by RLS regardless. This mirrors ADR-009's "RLS is
-- defense-in-depth, the RPC is the real gate" posture.
-- =============================================================================

ALTER TABLE public.ai_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_usage_counters'
      AND policyname = 'Users can view their own AI usage counters'
  ) THEN
    CREATE POLICY "Users can view their own AI usage counters"
      ON public.ai_usage_counters FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_usage_counters'
      AND policyname = 'Super admins can view all AI usage counters'
  ) THEN
    CREATE POLICY "Super admins can view all AI usage counters"
      ON public.ai_usage_counters FOR SELECT
      TO authenticated
      USING (public.is_super_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_usage_log'
      AND policyname = 'Users can view their own AI usage log'
  ) THEN
    CREATE POLICY "Users can view their own AI usage log"
      ON public.ai_usage_log FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_usage_log'
      AND policyname = 'Super admins can view all AI usage log'
  ) THEN
    CREATE POLICY "Super admins can view all AI usage log"
      ON public.ai_usage_log FOR SELECT
      TO authenticated
      USING (public.is_super_admin());
  END IF;
END $$;

-- =============================================================================
-- RPC: check_and_consume_ai_quota (ADR-010 canonical pattern)
--
-- Signature matches ADR-010's Implementation Notes exactly:
--   check_and_consume_ai_quota(p_feature text, p_limit int, p_window interval)
--
-- auth.uid() guard first (Rule #2 - enforcement is server-side only; the
-- RPC re-asserts identity itself rather than trusting the caller, same as
-- every ADR-009 RPC). Never keyed on IP (Rule #3).
--
-- Fixed windows are bucketed with date_bin, anchored to the Unix epoch, so
-- every caller checking the same feature within the same wall-clock window
-- computes the identical window_start key regardless of when it happens to
-- run - this is what makes the ON CONFLICT target a stable, shared row for
-- concurrent requests instead of a moving target.
--
-- The counter increment (INSERT ... ON CONFLICT ... DO UPDATE ...
-- RETURNING) is the single atomic statement that makes the whole
-- check-and-consume race-free (Rule #1/#2): two simultaneous calls from the
-- same user cannot both observe count N and both proceed as if under
-- limit. The counter is incremented unconditionally (even on the call that
-- trips the limit) - this is the standard fixed-window counter algorithm
-- and is deliberate: a denied request must not get a "free" retry inside
-- the same window by racing a fresh read.
--
-- A usage-log row (the metering record) is only inserted when the call is
-- actually allowed through: a blocked attempt never reaches Gemini, so it
-- is not "usage" (no cost was incurred).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_and_consume_ai_quota(
  p_feature text,
  p_limit integer,
  p_window interval
)
RETURNS TABLE (
  allowed boolean,
  current_count integer,
  quota_limit integer,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  bucket_start timestamptz;
  bucket_end timestamptz;
  new_count integer;
  is_allowed boolean;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_feature IS NULL OR btrim(p_feature) = '' THEN
    RAISE EXCEPTION 'Invalid feature key';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'Invalid quota limit: %', p_limit;
  END IF;

  IF p_window IS NULL OR p_window <= interval '0' THEN
    RAISE EXCEPTION 'Invalid quota window';
  END IF;

  bucket_start := date_bin(p_window, now(), timestamptz 'epoch');
  bucket_end := bucket_start + p_window;

  INSERT INTO public.ai_usage_counters (user_id, feature, window_start, request_count, updated_at)
  VALUES (uid, p_feature, bucket_start, 1, now())
  ON CONFLICT (user_id, feature, window_start)
  DO UPDATE SET
    request_count = public.ai_usage_counters.request_count + 1,
    updated_at = now()
  RETURNING request_count INTO new_count;

  is_allowed := new_count <= p_limit;

  IF is_allowed THEN
    INSERT INTO public.ai_usage_log (user_id, feature, created_at, size_estimate)
    VALUES (uid, p_feature, now(), NULL);
  END IF;

  RETURN QUERY SELECT
    is_allowed,
    new_count,
    p_limit,
    GREATEST(0, CEIL(EXTRACT(EPOCH FROM (bucket_end - now())))::integer);
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_consume_ai_quota(text, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_and_consume_ai_quota(text, integer, interval) TO authenticated;

-- =============================================================================
-- Verification: every new object must exist and be correctly configured.
-- Mirrors the self-verifying pattern used by migrations 012-015.
-- =============================================================================

DO $$
BEGIN
  IF to_regprocedure('public.check_and_consume_ai_quota(text,integer,interval)') IS NULL THEN
    RAISE EXCEPTION 'Migration 016 failed: check_and_consume_ai_quota does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'ai_usage_counters'
  ) THEN
    RAISE EXCEPTION 'Migration 016 failed: ai_usage_counters table does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'ai_usage_log'
  ) THEN
    RAISE EXCEPTION 'Migration 016 failed: ai_usage_log table does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_usage_counters'
      AND policyname = 'Users can view their own AI usage counters'
  ) THEN
    RAISE EXCEPTION 'Migration 016 failed: ai_usage_counters SELECT policy does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_usage_log'
      AND policyname = 'Users can view their own AI usage log'
  ) THEN
    RAISE EXCEPTION 'Migration 016 failed: ai_usage_log SELECT policy does not exist';
  END IF;
END $$;
