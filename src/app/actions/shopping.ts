"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { normalizeIngredientForMatch } from "@/lib/ingredient-match";
import { buildFoodResolver } from "@/lib/food-resolver";
import {
  buildShoppingSummary,
  collectShoppingRequirementNames,
  computeShoppingList,
  type ComputedShoppingEntry,
  type ShoppingListSummary,
} from "@/lib/shopping-list";
import {
  SHOPPING_LIST_SELECT,
  type ShoppingListInsertRow,
} from "@/lib/shopping-list-persistence";
import { foodsMatch, type FoodResolver } from "@/lib/semantic-match";
import { createClient } from "@/lib/supabase/server";
import type { MealPlanItem, ShoppingListItem } from "@/types/v2";

export type ShoppingActionResult =
  | { success: true }
  | { success: false; error: string };

export type ShoppingListResult = {
  items: ShoppingListItem[];
  summary: ShoppingListSummary;
};

type ExistingShoppingRow = {
  ingredient_name: string;
  quantity: number | null;
  unit: string | null;
  category: string;
  checked: boolean;
  needed_for_meals?: number | null;
  shortage_label?: string | null;
  demand_quantity?: number | null;
  demand_unit?: string | null;
  pantry_quantity?: number | null;
  pantry_unit?: string | null;
  used_by_meals?: string[] | null;
  source?: "manual" | "meal_plan" | null;
};

type PersistedShoppingRow = ShoppingListItem & {
  source: "manual" | "meal_plan";
};

async function getAuthenticatedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
}

async function fetchActivePlanItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<MealPlanItem[]> {
  const { data: plans } = await supabase
    .from("meal_plans")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);

  const plan = plans?.[0];
  if (!plan) {
    return [];
  }

  const { data: items } = await supabase
    .from("meal_plan_items")
    .select(
      "id, day_index, sort_order, meal_name, description, ingredients_used, missing_ingredients"
    )
    .eq("plan_id", plan.id)
    .eq("user_id", userId)
    .order("sort_order", { ascending: true });

  return (items ?? []).map((item) => ({
    id: item.id,
    day_index: item.day_index,
    sort_order: item.sort_order,
    meal_name: item.meal_name,
    description: item.description,
    ingredients_used: item.ingredients_used as string[],
    missing_ingredients: item.missing_ingredients as string[],
  }));
}

function ingredientInPantry(
  name: string,
  pantry: Array<{ ingredient_name: string }>,
  resolver?: FoodResolver | null
): boolean {
  return pantry.some((item) =>
    foodsMatch(name, item.ingredient_name, resolver)
  );
}

/**
 * Keeps user-added shopping rows that the meal-plan computation did not
 * produce, while dropping anything now covered by the pantry.
 */
function collectManualItemsToPreserve(
  existingItems: ExistingShoppingRow[],
  computedKeys: Set<string>,
  pantry: Array<{ ingredient_name: string }>,
  resolver?: FoodResolver | null
): ExistingShoppingRow[] {
  const preserved: ExistingShoppingRow[] = [];
  const seen = new Set<string>();

  for (const item of existingItems) {
    const key = normalizeIngredientForMatch(item.ingredient_name);

    if (computedKeys.has(key) || seen.has(key)) {
      continue;
    }

    if (ingredientInPantry(item.ingredient_name, pantry, resolver)) {
      continue;
    }

    seen.add(key);
    preserved.push(item);
  }

  return preserved;
}

function buildPersistedShoppingSummary(items: PersistedShoppingRow[]): ShoppingListSummary {
  return buildShoppingSummary(
    items.map((item) => ({
      ingredient_name: item.ingredient_name,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category,
      needed_for_meals: item.needed_for_meals,
      shortage_label: item.shortage_label,
      demand_quantity: item.demand_quantity,
      demand_unit: item.demand_unit,
      pantry_quantity: item.pantry_quantity,
      pantry_unit: item.pantry_unit,
      used_by_meals: item.used_by_meals,
    })),
    items.some((item) => item.source === "meal_plan")
  );
}

/**
 * Recomputes the shopping list from the active meal plan and pantry,
 * persists it to shopping_list_items, preserves checkbox state, and
 * keeps manually added items (e.g. from "Add Missing Items").
 */
export async function regenerateShoppingList(): Promise<ShoppingListResult> {
  const { supabase, user } = await getAuthenticatedUser();

  const [planItems, pantryResult, existingResult] = await Promise.all([
    fetchActivePlanItems(supabase, user.id),
    supabase
      .from("pantry")
      .select("ingredient_name, quantity, unit")
      .eq("user_id", user.id),
    supabase
      .from("shopping_list_items")
      .select(SHOPPING_LIST_SELECT)
      .eq("user_id", user.id),
  ]);

  const pantry = (pantryResult.data ?? []).map((item) => ({
    ingredient_name: item.ingredient_name,
    quantity: Number(item.quantity) || 0,
    unit: item.unit,
  }));

  const existingItems = (existingResult.data ?? []) as ExistingShoppingRow[];

  const checkedByName = new Map(
    existingItems.map((item) => [
      normalizeIngredientForMatch(item.ingredient_name),
      item.checked,
    ])
  );

  const resolver = await buildFoodResolver(supabase, [
    ...collectShoppingRequirementNames(planItems),
    ...pantry.map((item) => item.ingredient_name),
    ...existingItems.map((item) => item.ingredient_name),
  ]);

  const computed = computeShoppingList(planItems, pantry, resolver);
  const computedKeys = new Set(
    computed.map((item) =>
      normalizeIngredientForMatch(item.ingredient_name)
    )
  );

  const manualItems = collectManualItemsToPreserve(
    existingItems,
    computedKeys,
    pantry,
    resolver
  );

  const combinedForSummary: ComputedShoppingEntry[] = [
    ...computed,
    ...manualItems.map((item) => ({
      ingredient_name: item.ingredient_name,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category,
      needed_for_meals: 1,
      shortage_label: null,
      demand_quantity: item.demand_quantity ?? item.quantity,
      demand_unit: item.demand_unit ?? item.unit,
      pantry_quantity: item.pantry_quantity ?? 0,
      pantry_unit: item.pantry_unit ?? item.unit,
      used_by_meals: item.used_by_meals ?? [],
    })),
  ];

  const summary = buildShoppingSummary(
    combinedForSummary,
    planItems.length > 0
  );

  const rows: Omit<ShoppingListInsertRow, "user_id">[] = [
    ...computed.map((item) => ({
      ingredient_name: item.ingredient_name,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category,
      checked:
        checkedByName.get(
          normalizeIngredientForMatch(item.ingredient_name)
        ) ?? false,
      needed_for_meals: item.needed_for_meals,
      shortage_label: item.shortage_label,
      demand_quantity: item.demand_quantity,
      demand_unit: item.demand_unit,
      pantry_quantity: item.pantry_quantity,
      pantry_unit: item.pantry_unit,
      used_by_meals: item.used_by_meals,
      source: "meal_plan" as const,
    })),
    ...manualItems.map((item) => ({
      ingredient_name: item.ingredient_name,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category,
      checked: item.checked,
      needed_for_meals: item.needed_for_meals ?? 1,
      shortage_label: item.shortage_label ?? null,
      demand_quantity: item.demand_quantity ?? item.quantity,
      demand_unit: item.demand_unit ?? item.unit,
      pantry_quantity: item.pantry_quantity ?? 0,
      pantry_unit: item.pantry_unit ?? item.unit,
      used_by_meals: item.used_by_meals ?? [],
      source: item.source ?? "manual",
    })),
  ];

  // Single transaction: delete the user's previous rows and insert the
  // final computed set atomically (ADR-009 Task 2). An insert failure now
  // rolls back the delete too, so the previous list is never lost.
  const { data: persisted, error: regenerateError } = await supabase.rpc(
    "regenerate_shopping_list",
    { rows }
  );

  if (regenerateError) {
    console.error(
      "[regenerateShoppingList] regenerate_shopping_list RPC failed:",
      regenerateError
    );
    throw new Error("Unable to update your shopping list. Please try again.");
  }

  if (rows.length === 0) {
    return { items: [], summary };
  }

  const computedByName = new Map(
    computed.map((item) => [
      normalizeIngredientForMatch(item.ingredient_name),
      item,
    ])
  );

  type PersistedRegenerateRow = {
    id: string;
    ingredient_name: string;
    quantity: number | null;
    unit: string | null;
    category: string;
    checked: boolean;
    needed_for_meals: number | null;
    shortage_label: string | null;
    demand_quantity: number | null;
    demand_unit: string | null;
    pantry_quantity: number | null;
    pantry_unit: string | null;
    used_by_meals: string[] | null;
  };

  return {
    items: ((persisted ?? []) as PersistedRegenerateRow[]).map((item) => {
      const meta = computedByName.get(
        normalizeIngredientForMatch(item.ingredient_name)
      );
      return {
        id: item.id,
        ingredient_name: item.ingredient_name,
        quantity: item.quantity,
        unit: item.unit,
        category: item.category,
        checked: item.checked,
        needed_for_meals: item.needed_for_meals ?? meta?.needed_for_meals ?? 1,
        shortage_label: item.shortage_label ?? meta?.shortage_label ?? null,
        demand_quantity: item.demand_quantity ?? meta?.demand_quantity ?? item.quantity,
        demand_unit: item.demand_unit ?? meta?.demand_unit ?? item.unit,
        pantry_quantity: item.pantry_quantity ?? meta?.pantry_quantity ?? 0,
        pantry_unit: item.pantry_unit ?? meta?.pantry_unit ?? item.unit,
        used_by_meals: item.used_by_meals ?? meta?.used_by_meals ?? [],
      };
    }),
    summary,
  };
}

export async function getShoppingList(): Promise<ShoppingListResult> {
  const { supabase, user } = await getAuthenticatedUser();

  const { data, error } = await supabase
    .from("shopping_list_items")
    .select(SHOPPING_LIST_SELECT)
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const rows: PersistedShoppingRow[] = (data ?? []).map((item) => ({
    id: item.id,
    ingredient_name: item.ingredient_name,
    quantity: item.quantity,
    unit: item.unit,
    category: item.category,
    checked: item.checked,
    needed_for_meals: item.needed_for_meals ?? 1,
    shortage_label: item.shortage_label ?? null,
    demand_quantity: item.demand_quantity ?? item.quantity,
    demand_unit: item.demand_unit ?? item.unit,
    pantry_quantity: item.pantry_quantity ?? 0,
    pantry_unit: item.pantry_unit ?? item.unit,
    used_by_meals: item.used_by_meals ?? [],
    source: item.source ?? "manual",
  }));

  return {
    items: rows,
    summary: buildPersistedShoppingSummary(rows),
  };
}

export async function toggleShoppingItem(
  id: string,
  checked: boolean
): Promise<ShoppingActionResult> {
  const { supabase, user } = await getAuthenticatedUser();

  const { error } = await supabase
    .from("shopping_list_items")
    .update({ checked })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/shopping");
  revalidatePath("/dashboard");

  return { success: true };
}

export async function clearCheckedItems(): Promise<ShoppingActionResult> {
  const { supabase, user } = await getAuthenticatedUser();

  const { error } = await supabase
    .from("shopping_list_items")
    .delete()
    .eq("user_id", user.id)
    .eq("checked", true);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/shopping");
  revalidatePath("/dashboard");

  return { success: true };
}

export async function clearShoppingList(): Promise<ShoppingActionResult> {
  const { supabase, user } = await getAuthenticatedUser();

  const { error } = await supabase
    .from("shopping_list_items")
    .delete()
    .eq("user_id", user.id);

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/shopping");
  revalidatePath("/dashboard");

  return { success: true };
}

export async function triggerShoppingListRegeneration(): Promise<void> {
  await regenerateShoppingList();
  revalidatePath("/shopping");
  revalidatePath("/dashboard");
}
