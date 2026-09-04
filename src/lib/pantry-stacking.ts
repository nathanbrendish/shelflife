import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeIngredientForMatch,
  unitsAreCompatible,
} from "@/lib/ingredient-match";

type StackingClient = Pick<SupabaseClient, "from">;

/**
 * A pantry row ready to insert. `quantity` is summed when an equivalent row
 * already exists (same food identity + expiry + storage + compatible unit).
 */
export type PantryUpsertRow = {
  user_id: string;
  ingredient_name: string;
  quantity: number;
  unit: string | null;
  expiry_date: string | null;
  storage_location_id: string | null;
  canonical_food_id: string | null;
  cached_category_id: string | null;
  cached_subcategory_id: string | null;
  classification_version: number | null;
  classification_updated_at: string | null;
  updated_at: string;
};

type ExistingRow = {
  id: string;
  quantity: number | null;
  unit: string | null;
  ingredient_name: string;
  canonical_food_id: string | null;
};

/**
 * Two rows describe the same food when they resolve to the same canonical food.
 * When the incoming row has no canonical food (not yet in the knowledge graph),
 * fall back to a normalized-name identity so unresolved duplicates still stack.
 */
function isSameFood(
  row: Pick<ExistingRow, "canonical_food_id" | "ingredient_name">,
  incoming: PantryUpsertRow
): boolean {
  if (incoming.canonical_food_id) {
    return row.canonical_food_id === incoming.canonical_food_id;
  }
  return (
    normalizeIngredientForMatch(row.ingredient_name) ===
    normalizeIngredientForMatch(incoming.ingredient_name)
  );
}

/**
 * Finds an existing pantry row that the incoming row should stack onto.
 * Stacking requires the SAME: food (canonical id, or normalized name when
 * unresolved), expiry date, storage location, and a compatible unit (so we
 * never sum incompatible quantities such as "1 pack" + "200 g").
 */
async function findStackableRow(
  supabase: StackingClient,
  row: PantryUpsertRow
): Promise<ExistingRow | null> {
  let query = supabase
    .from("pantry")
    .select("id, quantity, unit, ingredient_name, canonical_food_id")
    .eq("user_id", row.user_id);

  query =
    row.expiry_date === null
      ? query.is("expiry_date", null)
      : query.eq("expiry_date", row.expiry_date);

  query =
    row.storage_location_id === null
      ? query.is("storage_location_id", null)
      : query.eq("storage_location_id", row.storage_location_id);

  const { data, error } = await query;
  if (error || !data) {
    return null;
  }

  return (
    (data as ExistingRow[]).find(
      (existing) =>
        isSameFood(existing, row) && unitsAreCompatible(existing.unit, row.unit)
    ) ?? null
  );
}

export type StackResult =
  | { status: "stacked" }
  | { status: "inserted" }
  | { status: "error"; error: string };

/**
 * Inserts a pantry row, or stacks its quantity onto an equivalent existing row.
 * Keeps the cache snapshot fresh on stack so classification stays current.
 */
export async function insertOrStackPantryItem(
  supabase: StackingClient,
  row: PantryUpsertRow
): Promise<StackResult> {
  const existing = await findStackableRow(supabase, row);

  if (existing) {
    const { error } = await supabase
      .from("pantry")
      .update({
        quantity: (Number(existing.quantity) || 0) + row.quantity,
        canonical_food_id: row.canonical_food_id,
        cached_category_id: row.cached_category_id,
        cached_subcategory_id: row.cached_subcategory_id,
        classification_version: row.classification_version,
        classification_updated_at: row.classification_updated_at,
        updated_at: row.updated_at,
      })
      .eq("id", existing.id)
      .eq("user_id", row.user_id);

    if (error) {
      return { status: "error", error: error.message };
    }
    return { status: "stacked" };
  }

  const { error } = await supabase.from("pantry").insert(row);
  if (error) {
    return { status: "error", error: error.message };
  }
  return { status: "inserted" };
}

export type ExistingPantryRow = ExistingRow & {
  expiry_date: string | null;
  storage_location_id: string | null;
};

/**
 * The final per-row outcome of a batch stacking plan: either `id` targets an
 * existing pantry row to update in place, or `id` is null and the row should
 * be inserted. Consumed verbatim as the `save_scanned_items` RPC payload
 * (ADR-009 Task 6) — this is the only place identity/stacking business logic
 * lives; the RPC just writes whatever this function decides.
 */
export type ScannedStackPlanRow = {
  id: string | null;
  quantity: number;
  ingredient_name: string;
  unit: string | null;
  expiry_date: string | null;
  storage_location_id: string | null;
  canonical_food_id: string | null;
  cached_category_id: string | null;
  cached_subcategory_id: string | null;
  classification_version: number | null;
  classification_updated_at: string | null;
  updated_at: string;
};

export type ScannedStackPlan = {
  rows: ScannedStackPlanRow[];
  added: number;
  duplicates: number;
};

/**
 * Plans a whole batch of scanned items against a single up-front read of the
 * user's pantry (`existingRows`), so identical or matching items within the
 * same receipt stack onto each other (and onto an existing row, if any)
 * before a single write. Mirrors the identity rules `insertOrStackPantryItem`
 * applies one row at a time: same food (canonical id, or normalized name when
 * unresolved), same expiry, same storage location, compatible unit.
 */
export function planScannedItemsStack(
  existingRows: ExistingPantryRow[],
  incoming: PantryUpsertRow[]
): ScannedStackPlan {
  const plan: ScannedStackPlanRow[] = [];
  let added = 0;
  let duplicates = 0;

  const matchesIdentity = (
    candidate: { expiry_date: string | null; storage_location_id: string | null; unit: string | null } & ExistingRow,
    row: PantryUpsertRow
  ) =>
    candidate.expiry_date === row.expiry_date &&
    candidate.storage_location_id === row.storage_location_id &&
    isSameFood(candidate, row) &&
    unitsAreCompatible(candidate.unit, row.unit);

  for (const row of incoming) {
    const batchMatch = plan.find(
      (entry) =>
        entry.expiry_date === row.expiry_date &&
        entry.storage_location_id === row.storage_location_id &&
        isSameFood(
          { canonical_food_id: entry.canonical_food_id, ingredient_name: entry.ingredient_name },
          row
        ) &&
        unitsAreCompatible(entry.unit, row.unit)
    );

    if (batchMatch) {
      batchMatch.quantity += row.quantity;
      batchMatch.canonical_food_id = row.canonical_food_id;
      batchMatch.cached_category_id = row.cached_category_id;
      batchMatch.cached_subcategory_id = row.cached_subcategory_id;
      batchMatch.classification_version = row.classification_version;
      batchMatch.classification_updated_at = row.classification_updated_at;
      batchMatch.updated_at = row.updated_at;
      duplicates++;
      continue;
    }

    const existing = existingRows.find((candidate) => matchesIdentity(candidate, row));

    plan.push({
      id: existing?.id ?? null,
      quantity: (Number(existing?.quantity) || 0) + row.quantity,
      ingredient_name: row.ingredient_name,
      unit: row.unit,
      expiry_date: row.expiry_date,
      storage_location_id: row.storage_location_id,
      canonical_food_id: row.canonical_food_id,
      cached_category_id: row.cached_category_id,
      cached_subcategory_id: row.cached_subcategory_id,
      classification_version: row.classification_version,
      classification_updated_at: row.classification_updated_at,
      updated_at: row.updated_at,
    });

    if (existing) {
      duplicates++;
    } else {
      added++;
    }
  }

  return { rows: plan, added, duplicates };
}
