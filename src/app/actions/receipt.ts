"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isValidIngredientName } from "@/lib/ingredient-utils";
import {
  recordCommunityFoodObservation,
  resolveCommunityFood,
} from "@/lib/community-foods";
import {
  planScannedItemsStack,
  type ExistingPantryRow,
  type PantryUpsertRow,
} from "@/lib/pantry-stacking";
import { createClient } from "@/lib/supabase/server";
import { triggerShoppingListRegeneration } from "@/app/actions/shopping";
import type { PantryIngredientInput } from "@/types/pantry";

export type SaveScannedIngredientsResult =
  | {
      success: true;
      added: number;
      duplicates: number;
      scanned: number;
    }
  | {
      success: false;
      error: string;
    };

type ScannedItem = {
  ingredient_name: string;
  quantity: number;
  unit: string | null;
  expiry_date: string | null;
  storage_location_id: string | null;
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
 * Records anonymous community learning and resolves a cache snapshot for the
 * pantry row. When the user picked a storage location in the review screen we
 * record it as a real community vote (matching manual add); otherwise we fall
 * back to the community-suggested location.
 */
async function enrichScannedItem(
  supabase: Awaited<ReturnType<typeof getAuthenticatedUser>>["supabase"],
  userId: string,
  item: ScannedItem
): Promise<PantryUpsertRow> {
  const base: PantryUpsertRow = {
    user_id: userId,
    ingredient_name: item.ingredient_name,
    quantity: item.quantity,
    unit: item.unit,
    expiry_date: item.expiry_date,
    updated_at: new Date().toISOString(),
    storage_location_id: item.storage_location_id,
    canonical_food_id: null,
    cached_category_id: null,
    cached_subcategory_id: null,
    classification_version: null,
    classification_updated_at: null,
  };

  try {
    const observation = await recordCommunityFoodObservation(supabase, {
      name: item.ingredient_name,
      unit: item.unit,
      shelfLifeDays: getShelfLifeDays(item.expiry_date),
      storageLocationId: item.storage_location_id,
    });

    const resolved = await resolveCommunityFood(supabase, item.ingredient_name);
    const canonicalId = resolved?.canonical_food_id ?? observation?.foodId ?? null;

    if (!canonicalId) {
      return base;
    }

    return {
      ...base,
      // Respect the user's explicit choice; only suggest when they left it blank.
      storage_location_id:
        item.storage_location_id ??
        resolved?.suggested_storage_location_id ??
        null,
      canonical_food_id: canonicalId,
      cached_category_id: resolved?.food_category_id ?? null,
      cached_subcategory_id: resolved?.food_subcategory_id ?? null,
      classification_version:
        resolved?.classification_version ?? observation?.version ?? null,
      classification_updated_at: new Date().toISOString(),
    };
  } catch {
    return base;
  }
}

export async function saveScannedIngredients(
  ingredients: PantryIngredientInput[]
): Promise<SaveScannedIngredientsResult> {
  const selected: ScannedItem[] = ingredients
    .map((item) => ({
      ingredient_name: item.ingredient_name.trim(),
      quantity: item.quantity > 0 ? item.quantity : 1,
      unit: item.unit?.trim() || null,
      expiry_date: item.expiry_date || null,
      storage_location_id: item.storage_location_id ?? null,
    }))
    .filter((item) => isValidIngredientName(item.ingredient_name));

  if (selected.length === 0) {
    return {
      success: false,
      error: "Select at least one ingredient to save.",
    };
  }

  const { supabase, user } = await getAuthenticatedUser();

  // Enrichment (community learning + classification lookups) stays
  // sequential per item so identical items in one batch resolve consistently,
  // but nothing is written to `pantry` yet — the whole batch is planned
  // against a single pantry read, then persisted in one transaction.
  const enriched: PantryUpsertRow[] = [];
  for (const item of selected) {
    enriched.push(await enrichScannedItem(supabase, user.id, item));
  }

  const { data: existingRows, error: pantryError } = await supabase
    .from("pantry")
    .select("id, quantity, unit, ingredient_name, canonical_food_id, expiry_date, storage_location_id")
    .eq("user_id", user.id);

  if (pantryError) {
    console.error("[saveScannedIngredients] pantry read failed:", pantryError);
    return { success: false, error: "Unable to save ingredients. Please try again." };
  }

  const { rows, added, duplicates } = planScannedItemsStack(
    (existingRows ?? []) as ExistingPantryRow[],
    enriched
  );

  const { error: saveError } = await supabase.rpc("save_scanned_items", {
    items: rows,
  });

  if (saveError) {
    console.error("[saveScannedIngredients] save_scanned_items RPC failed:", saveError);
    return { success: false, error: "Unable to save ingredients. Please try again." };
  }

  // The import is already committed at this point (save_scanned_items
  // succeeded), so a regen failure must not reject the action (M-2) — that
  // would tell the user their receipt import failed when it actually saved.
  try {
    await triggerShoppingListRegeneration();
  } catch (regenError) {
    console.error(
      "[saveScannedIngredients] shopping regen failed (non-fatal):",
      regenError
    );
  }

  revalidatePath("/pantry");
  revalidatePath("/dashboard");
  revalidatePath("/meals");
  revalidatePath("/planner");
  revalidatePath("/shopping");

  return {
    success: true,
    added,
    duplicates,
    scanned: selected.length,
  };
}
