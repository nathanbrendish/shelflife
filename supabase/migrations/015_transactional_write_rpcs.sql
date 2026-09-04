-- Transactional write RPCs (ADR-009)
--
-- Converts six multi-write Server Action code paths from sequential,
-- independent PostgREST calls into single-transaction PostgreSQL functions,
-- so a failure partway through can never leave the database in a
-- partially-written state. Business logic (matching, demand computation,
-- pantry stacking identity, cooking deduction order) stays in TypeScript
-- `src/lib/` modules exactly as before; every function below is a thin,
-- authorization-checked persistence boundary that receives an
-- already-computed payload and writes it atomically.
--
-- Every function is `LANGUAGE plpgsql SECURITY DEFINER SET search_path =
-- public`, with an `auth.uid()` (or `is_super_admin()`) guard as its first
-- statement, matching the existing pattern in `delete_user_account()` and
-- `refresh_stale_pantry_classifications()` (migrations 003, 007). RLS
-- remains defense-in-depth; these functions re-assert authorization
-- internally rather than relying on it alone.
--
-- This migration is purely additive: new functions, one new RLS policy, and
-- one new partial unique index. Nothing in migrations 001-014 is edited
-- (immutable, per ADR-008 §11.6).

-- =============================================================================
-- Task 1 (BUG-04) — Moderation audit integrity
--
-- Fixes the ordering defect where `community_foods` could be updated and the
-- `community_food_moderation_history` audit insert could then fail
-- separately (partly because no INSERT policy existed for it at all), never
-- correcting the just-committed data change. Both writes now happen in one
-- transaction, and the SUPER_ADMIN check happens twice: once by RLS (defense
-- in depth) and once explicitly inside the function (the real gate).
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'community_food_moderation_history'
      AND policyname = 'Super admins can insert moderation history'
  ) THEN
    CREATE POLICY "Super admins can insert moderation history"
      ON public.community_food_moderation_history FOR INSERT
      TO authenticated
      WITH CHECK (public.is_super_admin());
  END IF;
END $$;

-- `p_before` / `p_after` are opaque jsonb snapshots computed in TypeScript
-- (already the exact shape read from / about to be written to
-- `community_foods`), stored verbatim as the audit record. `p_after` is also
-- applied to `community_foods` as a partial update: only the keys present in
-- the object are written, so the same function serves both the narrow
-- approve/reject/lock/merge shape ({status, review_required, reviewed_at,
-- reviewed_by}) and the wider edit shape (canonical_name, taxonomy fields,
-- defaults, updated_at) without any per-action branching or business logic.
CREATE OR REPLACE FUNCTION public.moderate_community_food(
  p_action text,
  p_food_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_target_food_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
BEGIN
  IF actor IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_action NOT IN ('approved', 'rejected', 'merged', 'locked', 'edited') THEN
    RAISE EXCEPTION 'Invalid moderation action: %', p_action;
  END IF;

  UPDATE public.community_foods SET
    canonical_name = CASE WHEN p_after ? 'canonical_name' THEN p_after->>'canonical_name' ELSE canonical_name END,
    food_category_id = CASE WHEN p_after ? 'food_category_id' THEN NULLIF(p_after->>'food_category_id', '')::uuid ELSE food_category_id END,
    food_subcategory_id = CASE WHEN p_after ? 'food_subcategory_id' THEN NULLIF(p_after->>'food_subcategory_id', '')::uuid ELSE food_subcategory_id END,
    default_unit = CASE WHEN p_after ? 'default_unit' THEN p_after->>'default_unit' ELSE default_unit END,
    default_shelf_life_days = CASE WHEN p_after ? 'default_shelf_life_days' THEN (p_after->>'default_shelf_life_days')::integer ELSE default_shelf_life_days END,
    default_fridge_life_days = CASE WHEN p_after ? 'default_fridge_life_days' THEN (p_after->>'default_fridge_life_days')::integer ELSE default_fridge_life_days END,
    default_freezer_life_days = CASE WHEN p_after ? 'default_freezer_life_days' THEN (p_after->>'default_freezer_life_days')::integer ELSE default_freezer_life_days END,
    status = CASE WHEN p_after ? 'status' THEN p_after->>'status' ELSE status END,
    review_required = CASE WHEN p_after ? 'review_required' THEN (p_after->>'review_required')::boolean ELSE review_required END,
    reviewed_at = CASE WHEN p_after ? 'reviewed_at' THEN (p_after->>'reviewed_at')::timestamptz ELSE reviewed_at END,
    reviewed_by = CASE WHEN p_after ? 'reviewed_by' THEN (p_after->>'reviewed_by')::uuid ELSE reviewed_by END,
    updated_at = CASE WHEN p_after ? 'updated_at' THEN (p_after->>'updated_at')::timestamptz ELSE updated_at END
  WHERE id = p_food_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Community food not found: %', p_food_id;
  END IF;

  INSERT INTO public.community_food_moderation_history (
    community_food_id, action, actor_user_id, target_community_food_id,
    before_values, after_values
  ) VALUES (
    p_food_id, p_action, actor, p_target_food_id, p_before, p_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.moderate_community_food(text, uuid, jsonb, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.moderate_community_food(text, uuid, jsonb, jsonb, uuid) TO authenticated;

-- =============================================================================
-- Task 2 (BUG-01) — Regenerate shopping list
--
-- Replaces the naked delete-then-insert in `regenerateShoppingList()`. TS
-- keeps all computation (`computeShoppingList`, semantic resolution, manual
-- item preservation); this function receives the final row set and performs
-- the delete + insert as one transaction, so an insert failure can never
-- leave the user with a permanently empty shopping list (the previous rows
-- are still there, because the delete never committed either).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.regenerate_shopping_list(rows jsonb)
RETURNS SETOF public.shopping_list_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM public.shopping_list_items WHERE user_id = uid;

  IF rows IS NULL OR jsonb_array_length(rows) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.shopping_list_items (
    user_id, ingredient_name, quantity, unit, category, checked,
    needed_for_meals, shortage_label, demand_quantity, demand_unit,
    pantry_quantity, pantry_unit, used_by_meals, source
  )
  SELECT
    uid, r.ingredient_name, r.quantity, r.unit, r.category, r.checked,
    r.needed_for_meals, r.shortage_label, r.demand_quantity, r.demand_unit,
    r.pantry_quantity, r.pantry_unit, coalesce(r.used_by_meals, '[]'::jsonb), r.source
  FROM jsonb_to_recordset(rows) AS r(
    ingredient_name text, quantity numeric, unit text, category text, checked boolean,
    needed_for_meals integer, shortage_label text, demand_quantity numeric, demand_unit text,
    pantry_quantity numeric, pantry_unit text, used_by_meals jsonb, source text
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.regenerate_shopping_list(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.regenerate_shopping_list(jsonb) TO authenticated;

-- =============================================================================
-- Task 3 (BUG-02) — Replace / generate meal plan
--
-- Replaces the delete-plan / insert-plan / insert-items sequence in
-- `generateMealPlan()`. A failure inserting items now rolls back the delete
-- and the new plan row too, so the user is never left planless — the
-- previous plan (if any) simply remains exactly as it was.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.replace_meal_plan(p_days_count integer, p_items jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  new_plan_id uuid;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_days_count NOT IN (3, 5, 7) THEN
    RAISE EXCEPTION 'Invalid days_count: %', p_days_count;
  END IF;

  DELETE FROM public.meal_plans WHERE user_id = uid;

  INSERT INTO public.meal_plans (user_id, days_count)
  VALUES (uid, p_days_count)
  RETURNING id INTO new_plan_id;

  INSERT INTO public.meal_plan_items (
    plan_id, user_id, day_index, sort_order, meal_name, description,
    ingredients_used, missing_ingredients
  )
  SELECT
    new_plan_id, uid, i.day_index, i.sort_order, i.meal_name, i.description,
    coalesce(i.ingredients_used, '[]'::jsonb), coalesce(i.missing_ingredients, '[]'::jsonb)
  FROM jsonb_to_recordset(p_items) AS i(
    day_index integer, sort_order integer, meal_name text, description text,
    ingredients_used jsonb, missing_ingredients jsonb
  );

  RETURN new_plan_id;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_meal_plan(integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_meal_plan(integer, jsonb) TO authenticated;

-- =============================================================================
-- Task 4 (BUG-14) — Reorder meal plan items
--
-- Replaces N sequential per-row `UPDATE`s in `reorderMealPlanItems()` with a
-- single statement, so a mid-loop failure can no longer leave a partially
-- reordered plan (previously each row committed independently as its own
-- PostgREST request).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reorder_meal_plan_items(p_ordered_ids jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  UPDATE public.meal_plan_items m
  SET sort_order = o.idx
  FROM (
    SELECT
      (value)::uuid AS id,
      (ordinality - 1)::integer AS idx
    FROM jsonb_array_elements_text(p_ordered_ids) WITH ORDINALITY AS t(value, ordinality)
  ) o
  WHERE m.id = o.id AND m.user_id = uid;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_meal_plan_items(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reorder_meal_plan_items(jsonb) TO authenticated;

-- =============================================================================
-- Task 5 (BUG-03) — Complete cooked meal
--
-- Replaces the per-row pantry update/delete loop plus a separate
-- observations insert in `consumePantryForCookedMeal()`. Deduction matching
-- (which pantry rows to consume, in what order, by how much) stays in
-- `src/lib/pantry-consumption.ts`; this function receives the final
-- per-row outcome (`update` to a specific remaining quantity, or `delete`
-- once fully consumed) plus the observation rows, and applies both in one
-- transaction. Partial cooking completion (pantry changed but observations
-- lost, or vice versa) is no longer possible.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.complete_cooked_meal(p_deductions jsonb, p_observations jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_deductions IS NOT NULL AND jsonb_array_length(p_deductions) > 0 THEN
    UPDATE public.pantry p
    SET quantity = d.new_quantity, updated_at = now()
    FROM jsonb_to_recordset(p_deductions) AS d(id uuid, new_quantity numeric, action text)
    WHERE p.id = d.id AND p.user_id = uid AND d.action = 'update';

    DELETE FROM public.pantry p
    USING jsonb_to_recordset(p_deductions) AS d(id uuid, new_quantity numeric, action text)
    WHERE p.id = d.id AND p.user_id = uid AND d.action = 'delete';
  END IF;

  IF p_observations IS NOT NULL AND jsonb_array_length(p_observations) > 0 THEN
    INSERT INTO public.cooking_behavior_observations (
      recipe_id, recipe_name, expected_ingredient, actual_ingredient,
      expected_quantity, expected_unit, actual_quantity, actual_unit, action
    )
    SELECT
      o.recipe_id, o.recipe_name, o.expected_ingredient, o.actual_ingredient,
      o.expected_quantity, o.expected_unit, o.actual_quantity, o.actual_unit, o.action
    FROM jsonb_to_recordset(p_observations) AS o(
      recipe_id text, recipe_name text, expected_ingredient text, actual_ingredient text,
      expected_quantity numeric, expected_unit text, actual_quantity numeric, actual_unit text, action text
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_cooked_meal(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_cooked_meal(jsonb, jsonb) TO authenticated;

-- =============================================================================
-- Task 6 (BUG-07) — Save scanned receipt items
--
-- Replaces the per-item "find a stackable row, then insert-or-update" loop
-- in `saveScannedIngredients()`, where each item was its own independent
-- PostgREST request. Stacking identity (same canonical food or normalized
-- name, same expiry, same storage location, compatible unit) is still
-- resolved in TypeScript (`planScannedItemsStack` in
-- `src/lib/pantry-stacking.ts`) against a single up-front pantry read; this
-- function receives the final plan (an `id` to update, or `null` to insert)
-- and applies the whole batch as one transaction, so a mid-batch failure
-- imports nothing rather than partially committing.
--
-- The partial unique index below enforces the pantry stacking IDENTITY at the
-- database boundary — it is NOT a quantity-idempotency guarantee. It lets the
-- insert path use `ON CONFLICT ... DO UPDATE` so that when a row for the same
-- stacking identity appears concurrently (after the TS planner's snapshot
-- read), the two quantities are SUMMED onto one row instead of racing into a
-- duplicate — without duplicating the identity-matching business logic into
-- SQL. Because that path sums (see FUP-1 below), it is row-idempotent but NOT
-- quantity-idempotent: a genuinely resent identical request would add its
-- quantity again. Rows whose food is not yet resolved (`canonical_food_id IS
-- NULL`, an edge/error-path case) fall outside the partial index and are
-- simply inserted, matching today's fallback behaviour.
--
-- The key includes the raw unit (COALESCE(unit, '')) so it exactly matches
-- the application's stacking identity in `planScannedItemsStack` /
-- `insertOrStackPantryItem`, which never stacks incompatible or one-sided-null
-- units (H-1). The TS layer already merges COMPATIBLE units (e.g. "L" +
-- "litre") before reaching this insert path, so the index does not need to
-- replicate unit-synonym normalisation — it only needs to keep
-- incompatible/absent units as distinct rows, which the raw string does.
-- Two concurrent inserts with compatible-but-different raw units racing past
-- each other without merging is an accepted, deferred Phase-2 (BUG-05)
-- concurrency residual: no data is lost, they simply aren't summed.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS pantry_user_canonical_stack_idx
  ON public.pantry (
    user_id,
    canonical_food_id,
    COALESCE(expiry_date, '9999-12-31'::date),
    COALESCE(storage_location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(unit, '')
  )
  WHERE canonical_food_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.save_scanned_items(items jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF items IS NULL OR jsonb_array_length(items) = 0 THEN
    RETURN;
  END IF;

  -- Update path: items the TS planner matched onto an existing row (`id` is
  -- the target row's id). Only the fields the existing per-item stacking
  -- logic ever touched are written; identity fields (name/unit/expiry/
  -- storage) are intentionally left alone, exactly as before.
  UPDATE public.pantry p
  SET
    quantity = t.quantity,
    canonical_food_id = t.canonical_food_id,
    cached_category_id = t.cached_category_id,
    cached_subcategory_id = t.cached_subcategory_id,
    classification_version = t.classification_version,
    classification_updated_at = t.classification_updated_at,
    updated_at = t.updated_at
  FROM jsonb_to_recordset(items) AS t(
    id uuid, quantity numeric, ingredient_name text, unit text, expiry_date date,
    storage_location_id uuid, canonical_food_id uuid, cached_category_id uuid,
    cached_subcategory_id uuid, classification_version bigint,
    classification_updated_at timestamptz, updated_at timestamptz
  )
  WHERE p.id = t.id AND p.user_id = uid;

  -- Insert path: brand-new rows (`id` is null). `ON CONFLICT` on the partial
  -- unique index above catches a row that raced in for the same stacking
  -- identity after the planner's snapshot read and SUMS the quantities onto it
  -- (see FUP-1 below) instead of creating a duplicate. Row-idempotent, not
  -- quantity-idempotent. Unresolved foods (`canonical_food_id IS NULL`) never
  -- match that index and always insert.
  -- NULLIF: normalize '' -> NULL at the boundary so this SECURITY DEFINER
  -- entry point owns its stacking identity regardless of caller.
  INSERT INTO public.pantry (
    user_id, ingredient_name, quantity, unit, expiry_date, storage_location_id,
    canonical_food_id, cached_category_id, cached_subcategory_id,
    classification_version, classification_updated_at, updated_at
  )
  SELECT
    uid, t.ingredient_name, t.quantity, NULLIF(t.unit, ''), t.expiry_date, t.storage_location_id,
    t.canonical_food_id, t.cached_category_id, t.cached_subcategory_id,
    t.classification_version, t.classification_updated_at, t.updated_at
  FROM jsonb_to_recordset(items) AS t(
    id uuid, quantity numeric, ingredient_name text, unit text, expiry_date date,
    storage_location_id uuid, canonical_food_id uuid, cached_category_id uuid,
    cached_subcategory_id uuid, classification_version bigint,
    classification_updated_at timestamptz, updated_at timestamptz
  )
  WHERE t.id IS NULL
  ON CONFLICT (
    user_id, canonical_food_id,
    COALESCE(expiry_date, '9999-12-31'::date),
    COALESCE(storage_location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(unit, '')
  )
  WHERE canonical_food_id IS NOT NULL
  -- FUP-1: a conflict here only ever means a row created concurrently, after
  -- the TS planner already read the pantry snapshot it planned against (rows
  -- it knew about route through the UPDATE path above, never this insert).
  -- So the correct resolution is to SUM the quantities, not overwrite —
  -- overwriting would silently discard the concurrently-inserted quantity.
  DO UPDATE SET
    quantity = public.pantry.quantity + EXCLUDED.quantity,
    cached_category_id = EXCLUDED.cached_category_id,
    cached_subcategory_id = EXCLUDED.cached_subcategory_id,
    classification_version = EXCLUDED.classification_version,
    classification_updated_at = EXCLUDED.classification_updated_at,
    updated_at = EXCLUDED.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.save_scanned_items(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_scanned_items(jsonb) TO authenticated;

-- =============================================================================
-- Verification: every new object must exist and be correctly configured.
-- Mirrors the self-verifying pattern used by migrations 012/013/014.
-- =============================================================================

DO $$
DECLARE
  missing_functions text[];
BEGIN
  SELECT array_agg(sig) INTO missing_functions
  FROM unnest(ARRAY[
    'public.moderate_community_food(text,uuid,jsonb,jsonb,uuid)',
    'public.regenerate_shopping_list(jsonb)',
    'public.replace_meal_plan(integer,jsonb)',
    'public.reorder_meal_plan_items(jsonb)',
    'public.complete_cooked_meal(jsonb,jsonb)',
    'public.save_scanned_items(jsonb)'
  ]) AS sig
  WHERE to_regprocedure(sig) IS NULL;

  IF missing_functions IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 015 failed: missing functions %', missing_functions;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'pantry'
      AND indexname = 'pantry_user_canonical_stack_idx'
  ) THEN
    RAISE EXCEPTION 'Migration 015 failed: pantry_user_canonical_stack_idx does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'community_food_moderation_history'
      AND policyname = 'Super admins can insert moderation history'
  ) THEN
    RAISE EXCEPTION 'Migration 015 failed: moderation history INSERT policy does not exist';
  END IF;
END $$;
