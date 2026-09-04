"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { triggerShoppingListRegeneration } from "@/app/actions/shopping";
import {
  getExpiryDateFromDefault,
  recordCommunityFoodObservation,
  refreshStalePantryClassifications,
  resolveCommunityFood,
  classifyCommunityFood,
  type ResolvedCommunityFood,
} from "@/lib/community-foods";
import { insertOrStackPantryItem } from "@/lib/pantry-stacking";
import { createClient } from "@/lib/supabase/server";

export type PantryFormState = {
  error: string;
} | null;

export type PantryActionResult =
  | { success: true }
  | { success: false; error: string };

type PantryCacheSnapshot = {
  canonical_food_id: string | null;
  cached_category_id: string | null;
  cached_subcategory_id: string | null;
  classification_version: number | null;
  classification_updated_at: string | null;
};

const EMPTY_CACHE: PantryCacheSnapshot = {
  canonical_food_id: null,
  cached_category_id: null,
  cached_subcategory_id: null,
  classification_version: null,
  classification_updated_at: null,
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

function parseQuantity(value: FormDataEntryValue | null): number {
  const parsed = Number.parseFloat(String(value ?? "1"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getShelfLifeDays(expiryDate: string | null): number | null {
  if (!expiryDate) {
    return null;
  }

  const expiry = new Date(`${expiryDate}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) {
    return null;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((expiry.getTime() - today.getTime()) / 86_400_000));
}

/**
 * Records the anonymous community observation (including the user's storage
 * choice as a learned vote) and returns a fresh cache snapshot to persist on
 * the pantry row. Community learning must never block a pantry write, so any
 * failure resolves to an empty snapshot.
 */
async function learnAndSnapshot(
  supabase: Awaited<ReturnType<typeof createClient>>,
  data: {
    ingredientName: string;
    unit: string | null;
    expiryDate: string | null;
    storageLocationId: string | null;
  }
): Promise<PantryCacheSnapshot> {
  try {
    const observation = await recordCommunityFoodObservation(supabase, {
      name: data.ingredientName,
      unit: data.unit,
      shelfLifeDays: getShelfLifeDays(data.expiryDate),
      storageLocationId: data.storageLocationId,
    });

    const resolved = await resolveCommunityFood(supabase, data.ingredientName);

    const canonicalId = resolved?.canonical_food_id ?? observation?.foodId ?? null;
    if (!canonicalId) {
      return EMPTY_CACHE;
    }

    return {
      canonical_food_id: canonicalId,
      cached_category_id: resolved?.food_category_id ?? null,
      cached_subcategory_id: resolved?.food_subcategory_id ?? null,
      classification_version:
        resolved?.classification_version ?? observation?.version ?? null,
      classification_updated_at: new Date().toISOString(),
    };
  } catch {
    return EMPTY_CACHE;
  }
}

/**
 * Read-only resolution used by the add form to silently prefill unit, expiry
 * and a suggested storage location. Never prompts for classification.
 */
export async function getCommunityFoodDefaults(
  ingredientName: string
): Promise<(ResolvedCommunityFood & { default_expiry_date: string | null }) | null> {
  if (!ingredientName.trim()) {
    return null;
  }

  const { supabase } = await getAuthenticatedUser();

  try {
    const resolved = await resolveCommunityFood(supabase, ingredientName);
    if (!resolved) {
      return null;
    }

    return {
      ...resolved,
      default_expiry_date: getExpiryDateFromDefault(
        resolved.default_shelf_life_days
      ),
    };
  } catch {
    return null;
  }
}

export async function addIngredient(
  _prevState: PantryFormState,
  formData: FormData
): Promise<PantryFormState> {
  const ingredientName = (formData.get("ingredient_name") as string)?.trim();
  const quantity = parseQuantity(formData.get("quantity"));
  const unit = (formData.get("unit") as string)?.trim() || null;
  const storageLocationId =
    (formData.get("storage_location_id") as string)?.trim() || null;
  const expiryDate = (formData.get("expiry_date") as string)?.trim() || null;

  if (!ingredientName) {
    return { error: "Ingredient name is required." };
  }

  const { supabase, user } = await getAuthenticatedUser();

  const snapshot = await learnAndSnapshot(supabase, {
    ingredientName,
    unit,
    expiryDate,
    storageLocationId,
  });

  const result = await insertOrStackPantryItem(supabase, {
    user_id: user.id,
    ingredient_name: ingredientName,
    quantity,
    unit,
    expiry_date: expiryDate,
    storage_location_id: storageLocationId,
    updated_at: new Date().toISOString(),
    ...snapshot,
  });

  if (result.status === "error") {
    return { error: result.error };
  }

  await triggerShoppingListRegeneration();

  revalidatePath("/pantry");
  revalidatePath("/dashboard");
  return null;
}

export async function updatePantryItem(
  id: string,
  data: {
    ingredient_name: string;
    quantity: number;
    unit: string | null;
    expiry_date: string | null;
    storage_location_id: string | null;
  }
): Promise<PantryActionResult> {
  const ingredientName = data.ingredient_name.trim();

  if (!ingredientName) {
    return { success: false, error: "Ingredient name is required." };
  }

  if (!Number.isFinite(data.quantity) || data.quantity <= 0) {
    return { success: false, error: "Quantity must be greater than 0." };
  }

  const { supabase, user } = await getAuthenticatedUser();

  const snapshot = await learnAndSnapshot(supabase, {
    ingredientName,
    unit: data.unit?.trim() || null,
    expiryDate: data.expiry_date?.trim() || null,
    storageLocationId: data.storage_location_id,
  });

  const { error } = await supabase
    .from("pantry")
    .update({
      ingredient_name: ingredientName,
      quantity: data.quantity,
      unit: data.unit?.trim() || null,
      expiry_date: data.expiry_date?.trim() || null,
      storage_location_id: data.storage_location_id,
      updated_at: new Date().toISOString(),
      ...snapshot,
    })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return { success: false, error: error.message };
  }

  await triggerShoppingListRegeneration();

  revalidatePath("/pantry");
  revalidatePath("/dashboard");
  revalidatePath("/meals");

  return { success: true };
}

/**
 * Delayed, user-initiated classification. Records the user's controlled-category
 * vote into community learning and refreshes the caller's cached classifications
 * so any resulting change is reflected immediately.
 */
export async function classifyPantryFood(
  id: string,
  foodCategoryId: string,
  foodSubcategoryId: string | null
): Promise<PantryActionResult> {
  if (!foodCategoryId) {
    return { success: false, error: "A category is required." };
  }

  const { supabase, user } = await getAuthenticatedUser();

  const { data: item, error: fetchError } = await supabase
    .from("pantry")
    .select("ingredient_name")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (fetchError || !item) {
    return { success: false, error: "Ingredient not found." };
  }

  try {
    const result = await classifyCommunityFood(supabase, {
      name: item.ingredient_name,
      foodCategoryId,
      foodSubcategoryId,
    });

    if (result) {
      await supabase
        .from("pantry")
        .update({ canonical_food_id: result.foodId, classification_version: null })
        .eq("id", id)
        .eq("user_id", user.id);
    }

    await refreshStalePantryClassifications(supabase);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Classification failed.",
    };
  }

  revalidatePath("/pantry");
  revalidatePath("/dashboard");

  return { success: true };
}

/**
 * ADR-009 Task 7 (BUG-11): returns a safe `{ success, error? }` contract and
 * only regenerates the shopping list once the delete is confirmed to have
 * actually removed a row — a failed delete now surfaces to the UI instead of
 * silently proceeding as if it had succeeded.
 */
export async function deleteIngredient(
  _prevState: PantryFormState,
  formData: FormData
): Promise<PantryFormState> {
  const id = formData.get("id") as string;

  if (!id) {
    return { error: "Missing ingredient id." };
  }

  const { supabase, user } = await getAuthenticatedUser();

  const { error, count } = await supabase
    .from("pantry")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    console.error("[deleteIngredient] delete failed:", error);
    return { error: "Failed to remove ingredient. Please try again." };
  }

  if (!count) {
    return { error: "Ingredient not found." };
  }

  await triggerShoppingListRegeneration();

  revalidatePath("/pantry");
  revalidatePath("/dashboard");
  revalidatePath("/meals");

  return null;
}
