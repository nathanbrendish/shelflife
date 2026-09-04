import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildFoodResolver } from "@/lib/food-resolver";
import { unitsAreCompatible } from "@/lib/ingredient-match";
import { foodsMatch } from "@/lib/semantic-match";

type ConsumptionClient = Pick<SupabaseClient, "from" | "rpc">;

export type CookingUsageInput = {
  expectedIngredient: string | null;
  actualIngredient: string;
  expectedQuantity: number | null;
  expectedUnit: string | null;
  actualQuantity: number;
  actualUnit: string | null;
};

export type CompleteCookingInput = {
  userId: string;
  recipeId?: string | null;
  recipeName: string;
  ingredients: CookingUsageInput[];
};

type PantryRow = {
  id: string;
  ingredient_name: string;
  quantity: number | null;
  unit: string | null;
};

export type PantryDeduction = {
  id: string;
  new_quantity: number;
  action: "update" | "delete";
};

export type CookingObservationRow = {
  recipe_id: string | null;
  recipe_name: string;
  expected_ingredient: string | null;
  actual_ingredient: string;
  expected_quantity: number | null;
  expected_unit: string | null;
  actual_quantity: number;
  actual_unit: string | null;
  action: "used" | "skipped" | "extra" | "substituted";
};

function observationAction(
  item: CookingUsageInput
): CookingObservationRow["action"] {
  if (item.actualQuantity <= 0) return "skipped";
  if (!item.expectedIngredient) return "extra";
  if (
    item.expectedIngredient.trim().toLowerCase() !==
    item.actualIngredient.trim().toLowerCase()
  ) {
    return "substituted";
  }
  return "used";
}

/**
 * Plans (but does not write) the pantry deductions for one ingredient against
 * an in-memory snapshot of the user's pantry, mutating `pantryRows` so later
 * ingredients in the same batch see the effect of earlier ones. Matching
 * logic (which rows this ingredient consumes, in what order, by how much)
 * lives entirely here; the caller persists the resulting plan atomically.
 */
function planIngredientDeduction(
  pantryRows: PantryRow[],
  ingredient: CookingUsageInput,
  resolver: Awaited<ReturnType<typeof buildFoodResolver>>,
  deductions: Map<string, PantryDeduction>
) {
  let remaining = ingredient.actualQuantity;
  if (remaining <= 0) {
    return;
  }

  const matches = pantryRows.filter(
    (row) =>
      row.quantity !== null &&
      foodsMatch(ingredient.actualIngredient, row.ingredient_name, resolver) &&
      unitsAreCompatible(ingredient.actualUnit, row.unit)
  );

  for (const row of matches) {
    if (remaining <= 0) {
      break;
    }

    const currentQuantity = Number(row.quantity) || 0;
    const consumed = Math.min(currentQuantity, remaining);
    const nextQuantity = currentQuantity - consumed;
    remaining -= consumed;
    row.quantity = nextQuantity;

    deductions.set(row.id, {
      id: row.id,
      new_quantity: Math.max(0, nextQuantity),
      action: nextQuantity <= 0 ? "delete" : "update",
    });
  }
}

/**
 * Computes the pantry deductions and cooking-behaviour observations for a
 * completed meal, entirely in memory (no writes). ADR-009 Task 5 (BUG-03):
 * the caller persists the returned plan via the `complete_cooked_meal` RPC
 * in one transaction, so pantry changes and their observations can never
 * partially commit.
 */
export async function planCookedMealConsumption(
  supabase: ConsumptionClient,
  input: CompleteCookingInput
): Promise<{
  deductions: PantryDeduction[];
  observations: CookingObservationRow[];
}> {
  const ingredients = input.ingredients.filter((item) =>
    item.actualIngredient.trim()
  );

  if (ingredients.length === 0) {
    return { deductions: [], observations: [] };
  }

  const { data, error } = await supabase
    .from("pantry")
    .select("id, ingredient_name, quantity, unit")
    .eq("user_id", input.userId)
    .order("expiry_date", { ascending: true, nullsFirst: false });

  if (error) {
    throw new Error(error.message);
  }

  const pantryRows = (data ?? []).map((row) => ({
    id: row.id,
    ingredient_name: row.ingredient_name,
    quantity: Number(row.quantity) || 0,
    unit: row.unit,
  })) as PantryRow[];

  const resolver = await buildFoodResolver(supabase, [
    ...ingredients.map((item) => item.actualIngredient),
    ...ingredients
      .map((item) => item.expectedIngredient)
      .filter((name): name is string => Boolean(name)),
    ...pantryRows.map((item) => item.ingredient_name),
  ]);

  const deductions = new Map<string, PantryDeduction>();
  for (const ingredient of ingredients) {
    planIngredientDeduction(pantryRows, ingredient, resolver, deductions);
  }

  const observations: CookingObservationRow[] = ingredients.map((item) => ({
    recipe_id: input.recipeId ?? null,
    recipe_name: input.recipeName,
    expected_ingredient: item.expectedIngredient,
    actual_ingredient: item.actualIngredient,
    expected_quantity: item.expectedQuantity,
    expected_unit: item.expectedUnit,
    actual_quantity: item.actualQuantity,
    actual_unit: item.actualUnit,
    action: observationAction(item),
  }));

  return { deductions: Array.from(deductions.values()), observations };
}
