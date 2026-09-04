// ADR-009 Phase 0 (P0-3) fault-injection harness, and the Phase 1 DoD proof
// for Tasks 1, 2, 3, 5, 6: force the second (or later) write in a previously
// multi-step sequence to fail, and assert the whole transaction rolled back
// — nothing partially committed. Requires a live local Supabase Postgres:
//
//   supabase start   (or CI's minimal db-only start)
//   supabase db reset
//   npm run test:fault-injection
//
// These are integration tests against real Postgres, deliberately excluded
// from `npm test` (which must stay dependency-free for local/CI speed) and
// run only in the migration-chain CI job, right after a clean `db reset`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { withClient, createTestUser, actAs, expectRejects } from "./helpers/db.mjs";

test("Task 1 (BUG-04): moderate_community_food commits the food update and its audit row atomically", async () => {
  await withClient(async (client) => {
    const adminId = await createTestUser(client, { superAdmin: true });
    await actAs(client, adminId);

    const uniqueName = `fault injection food ${Date.now()}`;
    const { rows: foodRows } = await client.query(
      `INSERT INTO public.community_foods (canonical_name, normalized_name, status)
       VALUES ($1, $1, 'candidate')
       RETURNING id`,
      [uniqueName]
    );
    const foodId = foodRows[0].id;

    // Happy path: update + audit insert both commit.
    await client.query(
      `SELECT public.moderate_community_food($1, $2, $3::jsonb, $4::jsonb, NULL)`,
      [
        "approved",
        foodId,
        JSON.stringify({ status: "candidate" }),
        JSON.stringify({ status: "verified", review_required: false }),
      ]
    );

    const { rows: afterApprove } = await client.query(
      `SELECT status FROM public.community_foods WHERE id = $1`,
      [foodId]
    );
    assert.equal(afterApprove[0].status, "verified");

    const { rows: historyAfterApprove } = await client.query(
      `SELECT action FROM public.community_food_moderation_history WHERE community_food_id = $1`,
      [foodId]
    );
    assert.equal(historyAfterApprove.length, 1);

    // Fault injection: a valid action (passes the RPC's own guard, so the
    // community_foods UPDATE runs) but a target_food_id that doesn't exist,
    // which violates the audit table's FK — the second write fails.
    await expectRejects(
      client.query(
        `SELECT public.moderate_community_food($1, $2, $3::jsonb, $4::jsonb, $5)`,
        [
          "merged",
          foodId,
          JSON.stringify({ status: "verified" }),
          JSON.stringify({ status: "locked" }),
          "00000000-0000-0000-0000-000000000099",
        ]
      )
    );

    // Prove atomicity: the status change from the failed call never
    // committed — it is still exactly what the happy path left it as.
    const { rows: afterFault } = await client.query(
      `SELECT status FROM public.community_foods WHERE id = $1`,
      [foodId]
    );
    assert.equal(afterFault[0].status, "verified");

    const { rows: historyAfterFault } = await client.query(
      `SELECT action FROM public.community_food_moderation_history WHERE community_food_id = $1`,
      [foodId]
    );
    assert.equal(historyAfterFault.length, 1, "no new audit row from the failed call");
  });
});

test("Task 2 (BUG-01): regenerate_shopping_list never leaves the list empty on a failed insert", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    await client.query(
      `SELECT public.regenerate_shopping_list($1::jsonb)`,
      [
        JSON.stringify([
          {
            ingredient_name: "Milk",
            quantity: 2,
            unit: "L",
            category: "Dairy",
            checked: false,
            needed_for_meals: 1,
            source: "meal_plan",
          },
        ]),
      ]
    );

    const { rows: happyRows } = await client.query(
      `SELECT ingredient_name FROM public.shopping_list_items WHERE user_id = $1`,
      [userId]
    );
    assert.equal(happyRows.length, 1);

    // Fault injection: the second row has no ingredient_name (NOT NULL),
    // so the insert fails after the delete has already run in the same
    // transaction.
    await expectRejects(
      client.query(`SELECT public.regenerate_shopping_list($1::jsonb)`, [
        JSON.stringify([
          { ingredient_name: "Eggs", quantity: 12, unit: "pcs", category: "Dairy", checked: false, needed_for_meals: 1, source: "meal_plan" },
          { ingredient_name: null, quantity: 1, unit: "pcs", category: "Dairy", checked: false, needed_for_meals: 1, source: "meal_plan" },
        ]),
      ])
    );

    const { rows: afterFault } = await client.query(
      `SELECT ingredient_name FROM public.shopping_list_items WHERE user_id = $1`,
      [userId]
    );
    assert.deepEqual(
      afterFault.map((r) => r.ingredient_name),
      ["Milk"],
      "the previous list must survive a failed regeneration"
    );
  });
});

test("Task 3 (BUG-02): replace_meal_plan leaves the existing plan intact on a failed item insert", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    const originalPlanId = await client.query(
      `SELECT public.replace_meal_plan(3, $1::jsonb) AS id`,
      [
        JSON.stringify([
          { day_index: 0, sort_order: 0, meal_name: "Pasta", description: "", ingredients_used: [], missing_ingredients: [] },
        ]),
      ]
    );
    const planId = originalPlanId.rows[0].id;

    // Fault injection: the second item has no meal_name (NOT NULL), so the
    // insert fails after the old plan has already been deleted and the new
    // plan row has already been inserted in the same transaction.
    await expectRejects(
      client.query(`SELECT public.replace_meal_plan(5, $1::jsonb)`, [
        JSON.stringify([
          { day_index: 0, sort_order: 0, meal_name: "Soup", description: "", ingredients_used: [], missing_ingredients: [] },
          { day_index: 1, sort_order: 0, meal_name: null, description: "", ingredients_used: [], missing_ingredients: [] },
        ]),
      ])
    );

    const { rows: plans } = await client.query(
      `SELECT id, days_count FROM public.meal_plans WHERE user_id = $1`,
      [userId]
    );
    assert.equal(plans.length, 1, "the user must never end up planless");
    assert.equal(plans[0].id, planId, "the original plan must survive a failed replacement");
    assert.equal(plans[0].days_count, 3);

    const { rows: items } = await client.query(
      `SELECT meal_name FROM public.meal_plan_items WHERE plan_id = $1`,
      [planId]
    );
    assert.deepEqual(items.map((r) => r.meal_name), ["Pasta"]);
  });
});

test("Task 5 (BUG-03): complete_cooked_meal rolls back pantry deductions when the observation insert fails", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    const { rows: pantryRows } = await client.query(
      `INSERT INTO public.pantry (user_id, ingredient_name, quantity, unit)
       VALUES ($1, 'Flour', 5, 'kg')
       RETURNING id`,
      [userId]
    );
    const pantryId = pantryRows[0].id;

    // L-3: a unique recipe_name (like the other tests' unique identifiers)
    // instead of a fixed literal, so this assertion never depends on reset
    // state or the order tests happen to run in.
    const recipeName = `fault injection bread ${Date.now()}`;

    // Fault injection: a valid deduction (which would apply cleanly on its
    // own) paired with an observation whose `action` violates the table's
    // CHECK constraint — the pantry write must not survive.
    await expectRejects(
      client.query(
        `SELECT public.complete_cooked_meal($1::jsonb, $2::jsonb)`,
        [
          JSON.stringify([{ id: pantryId, new_quantity: 2, action: "update" }]),
          JSON.stringify([
            {
              recipe_id: "r1",
              recipe_name: recipeName,
              expected_ingredient: "Flour",
              actual_ingredient: "Flour",
              expected_quantity: 3,
              expected_unit: "kg",
              actual_quantity: 3,
              actual_unit: "kg",
              action: "not_a_real_action",
            },
          ]),
        ]
      )
    );

    const { rows: pantryAfter } = await client.query(
      `SELECT quantity FROM public.pantry WHERE id = $1`,
      [pantryId]
    );
    assert.equal(
      Number(pantryAfter[0].quantity),
      5,
      "pantry deduction must roll back when the paired observation insert fails"
    );

    const { rows: observations } = await client.query(
      `SELECT id FROM public.cooking_behavior_observations WHERE recipe_name = $1`,
      [recipeName]
    );
    assert.equal(observations.length, 0);
  });
});

test("Task 6 (BUG-07): save_scanned_items imports nothing from a batch that fails partway", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    const uniqueName = `scanned fault food ${Date.now()}`;
    const { rows: foodRows } = await client.query(
      `INSERT INTO public.community_foods (canonical_name, normalized_name, status)
       VALUES ($1, $1, 'candidate')
       RETURNING id`,
      [uniqueName]
    );
    const validFoodId = foodRows[0].id;

    // Fault injection: the first item is well-formed; the second references
    // a canonical_food_id that does not exist, violating the pantry FK. The
    // whole batch must import nothing.
    await expectRejects(
      client.query(`SELECT public.save_scanned_items($1::jsonb)`, [
        JSON.stringify([
          {
            id: null,
            quantity: 1,
            ingredient_name: "Good Item",
            unit: "can",
            expiry_date: null,
            storage_location_id: null,
            canonical_food_id: validFoodId,
            cached_category_id: null,
            cached_subcategory_id: null,
            classification_version: 1,
            classification_updated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: null,
            quantity: 1,
            ingredient_name: "Bad Item",
            unit: "unit",
            expiry_date: null,
            storage_location_id: null,
            canonical_food_id: "00000000-0000-0000-0000-000000000099",
            cached_category_id: null,
            cached_subcategory_id: null,
            classification_version: null,
            classification_updated_at: null,
            updated_at: new Date().toISOString(),
          },
        ]),
      ])
    );

    const { rows: pantryAfter } = await client.query(
      `SELECT ingredient_name FROM public.pantry WHERE user_id = $1`,
      [userId]
    );
    assert.equal(pantryAfter.length, 0, "a mid-batch failure must import nothing");

    // Retry with only the valid item now succeeds, and a second identical
    // retry does not duplicate it (idempotent via the partial unique index).
    const validItem = {
      id: null,
      quantity: 1,
      ingredient_name: "Good Item",
      unit: "can",
      expiry_date: null,
      storage_location_id: null,
      canonical_food_id: validFoodId,
      cached_category_id: null,
      cached_subcategory_id: null,
      classification_version: 1,
      classification_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await client.query(`SELECT public.save_scanned_items($1::jsonb)`, [
      JSON.stringify([validItem]),
    ]);
    await client.query(`SELECT public.save_scanned_items($1::jsonb)`, [
      JSON.stringify([validItem]),
    ]);

    const { rows: afterRetry } = await client.query(
      `SELECT count(*)::int AS count, sum(quantity)::numeric AS total FROM public.pantry WHERE user_id = $1 AND ingredient_name = 'Good Item'`,
      [userId]
    );
    assert.equal(afterRetry[0].count, 1, "retrying an identical request must not duplicate the row");
    // FUP-1: the conflict must SUM the quantity (1 + 1 = 2), not overwrite it
    // back down to 1 — overwriting would silently discard the retried item.
    assert.equal(
      Number(afterRetry[0].total),
      2,
      "a resolved-food retry must sum onto the existing row, not overwrite it"
    );
  });
});

test("Task 6 (H-1): same food/expiry/storage but incompatible or absent units import as distinct rows, not a conflict", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    const uniqueName = `h1 fault food ${Date.now()}`;
    const { rows: foodRows } = await client.query(
      `INSERT INTO public.community_foods (canonical_name, normalized_name, status)
       VALUES ($1, $1, 'candidate')
       RETURNING id`,
      [uniqueName]
    );
    const foodId = foodRows[0].id;

    const baseItem = {
      id: null,
      quantity: 1,
      ingredient_name: uniqueName,
      expiry_date: null,
      storage_location_id: null,
      canonical_food_id: foodId,
      cached_category_id: null,
      cached_subcategory_id: null,
      classification_version: 1,
      classification_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Before H-1, all three of these collided on the same ON CONFLICT
    // arbiter (unit was outside the index), which made Postgres raise
    // "ON CONFLICT DO UPDATE command cannot affect row a second time" and
    // roll back the entire batch. `planScannedItemsStack` only ever emits
    // separate insert-path rows like this for units it does NOT consider
    // stackable (`unitsAreCompatible` false), so the fix must keep them
    // as distinct rows instead of rejecting the batch.
    await client.query(`SELECT public.save_scanned_items($1::jsonb)`, [
      JSON.stringify([
        { ...baseItem, unit: null },
        { ...baseItem, unit: "L" },
        { ...baseItem, unit: "ml" },
      ]),
    ]);

    const { rows: afterImport } = await client.query(
      `SELECT unit, quantity FROM public.pantry WHERE user_id = $1 AND canonical_food_id = $2`,
      [userId, foodId]
    );
    assert.equal(afterImport.length, 3, "incompatible/absent units must import as three distinct rows");
    const byUnit = new Map(afterImport.map((r) => [r.unit, Number(r.quantity)]));
    assert.deepEqual(
      new Set(byUnit.keys()),
      new Set([null, "L", "ml"]),
      "each unit must have landed in its own distinct row"
    );
    assert.ok(
      [...byUnit.values()].every((quantity) => quantity === 1),
      "each distinct-unit row must keep its own quantity, never merged with another unit's"
    );
  });
});

test("Task 2 fast-follow: save_scanned_items normalizes a raw unit:'' to NULL at the boundary, collapsing onto a unit:null row", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    const uniqueName = `boundary normalize food ${Date.now()}`;
    const { rows: foodRows } = await client.query(
      `INSERT INTO public.community_foods (canonical_name, normalized_name, status)
       VALUES ($1, $1, 'candidate')
       RETURNING id`,
      [uniqueName]
    );
    const foodId = foodRows[0].id;

    const baseItem = {
      id: null,
      quantity: 1,
      ingredient_name: uniqueName,
      expiry_date: null,
      storage_location_id: null,
      canonical_food_id: foodId,
      cached_category_id: null,
      cached_subcategory_id: null,
      classification_version: 1,
      classification_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // A raw caller (bypassing the TS layer's own '' -> null normalization)
    // sends a literal empty-string unit. The RPC is a SECURITY DEFINER entry
    // point and must not depend on the caller having normalized it.
    await client.query(`SELECT public.save_scanned_items($1::jsonb)`, [
      JSON.stringify([{ ...baseItem, unit: "" }]),
    ]);

    const { rows: afterFirst } = await client.query(
      `SELECT unit, quantity FROM public.pantry WHERE user_id = $1 AND canonical_food_id = $2`,
      [userId, foodId]
    );
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0].unit, null, "'' must be persisted as NULL, not the literal empty string");

    // A second batch for the same identity with an actual NULL unit must
    // collapse onto the same row (sum, per FUP-1) rather than creating a
    // second row — proving '' and NULL are treated as the identical
    // stacking identity end to end, not just at the index-key level.
    await client.query(`SELECT public.save_scanned_items($1::jsonb)`, [
      JSON.stringify([{ ...baseItem, unit: null }]),
    ]);

    const { rows: afterSecond } = await client.query(
      `SELECT unit, quantity FROM public.pantry WHERE user_id = $1 AND canonical_food_id = $2`,
      [userId, foodId]
    );
    assert.equal(afterSecond.length, 1, "'' and null for the same identity must collapse to a single row");
    assert.equal(afterSecond[0].unit, null);
    assert.equal(Number(afterSecond[0].quantity), 2, "the second row must sum onto the first, per FUP-1");
  });
});
