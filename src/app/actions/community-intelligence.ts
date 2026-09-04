"use server";

import { revalidatePath } from "next/cache";
import { calculateCommunityConfidence } from "@/lib/community-food-confidence";
import { requireSuperAdmin } from "@/lib/platform-auth";
import type {
  CommunityFoodVote,
  CommunityFoodModerationAction,
  CommunityFoodRecord,
  CommunityIntelligenceDashboardData,
} from "@/types/community-intelligence";
import type {
  FoodCategory,
  FoodSubcategory,
  StorageLocation,
} from "@/types/taxonomy";

export type CommunityActionResult =
  | { success: true }
  | { success: false; error: string };

type EditableCommunityFood = {
  canonicalName: string;
  foodCategoryId: string | null;
  foodSubcategoryId: string | null;
  defaultUnit: string | null;
  defaultShelfLifeDays: number | null;
  defaultFridgeLifeDays: number | null;
  defaultFreezerLifeDays: number | null;
};

function normalizeEditableValue(value: string | null): string | null {
  return value?.trim() || null;
}

async function getFoodOrThrow(
  supabase: Awaited<ReturnType<typeof requireSuperAdmin>>["supabase"],
  foodId: string
) {
  const { data, error } = await supabase
    .from("community_foods")
    .select("*")
    .eq("id", foodId)
    .single();

  if (error || !data) {
    if (error) {
      console.error("[getFoodOrThrow] community_foods read failed:", error);
    }
    throw new Error("Community food was not found.");
  }

  return data as CommunityFoodRecord;
}

/**
 * Applies a `community_foods` change and its moderation-history audit row in
 * one transaction (ADR-009 Task 1 / BUG-04). Previously these were two
 * independent writes — an update followed by a separate insert that could
 * fail on its own (there was no INSERT policy for it at all), leaving the
 * data change committed with no audit trail. The RPC re-asserts
 * `is_super_admin()` internally; `requireSuperAdmin()` remains the read-path
 * / page-access guard.
 */
async function recordModerationAction(
  supabase: Awaited<ReturnType<typeof requireSuperAdmin>>["supabase"],
  communityFoodId: string,
  action: CommunityFoodModerationAction,
  beforeValues: Record<string, unknown>,
  afterValues: Record<string, unknown>,
  targetCommunityFoodId: string | null = null
) {
  const { error } = await supabase.rpc("moderate_community_food", {
    p_action: action,
    p_food_id: communityFoodId,
    p_before: beforeValues,
    p_after: afterValues,
    p_target_food_id: targetCommunityFoodId,
  });

  if (error) {
    console.error("[recordModerationAction] moderate_community_food RPC failed:", error);
    throw new Error("Failed to record this moderation action. Please try again.");
  }
}

function revalidatePlatform() {
  revalidatePath("/platform");
}

export async function getCommunityIntelligenceDashboardData(): Promise<CommunityIntelligenceDashboardData> {
  const { supabase } = await requireSuperAdmin();
  const [
    foodsResult,
    aliasesResult,
    historyResult,
    votesResult,
    categoriesResult,
    subcategoriesResult,
    storageResult,
  ] = await Promise.all([
    supabase
      .from("community_foods")
      .select("*")
      .order("review_required", { ascending: false })
      .order("usage_count", { ascending: false })
      .limit(100),
    supabase
      .from("community_food_aliases")
      .select("*")
      .order("usage_count", { ascending: false })
      .limit(10),
    supabase
      .from("community_food_moderation_history")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("community_food_votes")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("food_categories")
      .select("id, name, icon, display_order, active, taxonomy_version")
      .order("display_order"),
    supabase
      .from("food_subcategories")
      .select(
        "id, food_category_id, name, icon, display_order, active, taxonomy_version, substitutable"
      )
      .order("display_order"),
    supabase
      .from("storage_locations")
      .select("id, name, icon, display_order, active")
      .order("display_order"),
  ]);

  if (
    foodsResult.error ||
    aliasesResult.error ||
    historyResult.error ||
    votesResult.error ||
    categoriesResult.error ||
    subcategoriesResult.error ||
    storageResult.error
  ) {
    throw new Error(
      foodsResult.error?.message ??
        aliasesResult.error?.message ??
        historyResult.error?.message ??
        votesResult.error?.message ??
        categoriesResult.error?.message ??
        subcategoriesResult.error?.message ??
        storageResult.error?.message ??
        "Unable to load Community Intelligence."
    );
  }

  const foods = (foodsResult.data ?? []) as CommunityFoodRecord[];
  const votesByFood = new Map<string, CommunityFoodVote[]>();
  for (const vote of (votesResult.data ?? []) as CommunityFoodVote[]) {
    const votes = votesByFood.get(vote.community_food_id) ?? [];
    votes.push(vote);
    votesByFood.set(vote.community_food_id, votes);
  }
  const confidenceBreakdowns = Object.fromEntries(
    foods.map((food) => {
      const votes = votesByFood.get(food.id) ?? [];
      const agreement = <T,>(
        values: Array<T | null>,
        expected: T | null
      ) => {
        const observed = values.filter((value): value is T => value !== null);
        if (expected === null || observed.length === 0) return 0;
        return (
          (observed.filter((value) => value === expected).length /
            observed.length) *
          100
        );
      };
      return [
        food.id,
        calculateCommunityConfidence({
          usageCount: food.usage_count,
          categoryAgreement: agreement(
            votes.map((vote) => vote.food_category_id),
            food.food_category_id
          ),
          unitAgreement: agreement(
            votes.map((vote) => vote.unit),
            food.default_unit
          ),
          shelfLifeAgreement: agreement(
            votes.map((vote) => vote.shelf_life_days),
            food.default_shelf_life_days
          ),
        }),
      ];
    })
  );

  return {
    metrics: {
      totalFoods: foods.length,
      candidates: foods.filter((food) => food.status === "candidate").length,
      awaitingReview: foods.filter((food) => food.review_required).length,
      verified: foods.filter((food) => food.status === "verified").length,
      locked: foods.filter((food) => food.status === "locked").length,
    },
    foods,
    topAliases: aliasesResult.data ?? [],
    moderationHistory: historyResult.data ?? [],
    confidenceBreakdowns,
    categories: (categoriesResult.data ?? []) as FoodCategory[],
    subcategories: (subcategoriesResult.data ?? []) as FoodSubcategory[],
    storageLocations: (storageResult.data ?? []) as StorageLocation[],
  };
}

export async function approveCommunityFood(
  foodId: string
): Promise<CommunityActionResult> {
  try {
    const { supabase, userId } = await requireSuperAdmin();
    const before = await getFoodOrThrow(supabase, foodId);
    const after = {
      status: "verified",
      review_required: false,
      reviewed_at: new Date().toISOString(),
      reviewed_by: userId,
    };
    await recordModerationAction(supabase, foodId, "approved", before, after);
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Approval failed." };
  }
}

async function lockCommunityFood(
  foodId: string,
  action: "rejected" | "locked"
): Promise<CommunityActionResult> {
  try {
    const { supabase, userId } = await requireSuperAdmin();
    const before = await getFoodOrThrow(supabase, foodId);
    const after = {
      status: "locked",
      review_required: false,
      reviewed_at: new Date().toISOString(),
      reviewed_by: userId,
    };
    await recordModerationAction(supabase, foodId, action, before, after);
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Moderation failed." };
  }
}

export async function rejectCommunityFood(foodId: string) {
  return lockCommunityFood(foodId, "rejected");
}

export async function lockCommunityFoodEntry(foodId: string) {
  return lockCommunityFood(foodId, "locked");
}

export async function editCommunityFood(
  foodId: string,
  values: EditableCommunityFood
): Promise<CommunityActionResult> {
  try {
    const { supabase } = await requireSuperAdmin();
    const before = await getFoodOrThrow(supabase, foodId);
    const canonicalName = values.canonicalName.trim();
    if (!canonicalName) {
      return { success: false, error: "Canonical name is required." };
    }

    const after = {
      canonical_name: canonicalName,
      food_category_id: values.foodCategoryId,
      food_subcategory_id: values.foodSubcategoryId,
      default_unit: normalizeEditableValue(values.defaultUnit),
      default_shelf_life_days: values.defaultShelfLifeDays,
      default_fridge_life_days: values.defaultFridgeLifeDays,
      default_freezer_life_days: values.defaultFreezerLifeDays,
      updated_at: new Date().toISOString(),
    };
    await recordModerationAction(supabase, foodId, "edited", before, after);
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Edit failed." };
  }
}

export async function mergeCommunityFoods(
  sourceFoodId: string,
  targetFoodId: string
): Promise<CommunityActionResult> {
  if (sourceFoodId === targetFoodId) {
    return { success: false, error: "Choose a different food to merge into." };
  }

  try {
    const { supabase, userId } = await requireSuperAdmin();
    const [source, target] = await Promise.all([
      getFoodOrThrow(supabase, sourceFoodId),
      getFoodOrThrow(supabase, targetFoodId),
    ]);
    const [{ data: sourceAliases, error: sourceAliasesError }, { data: targetAliases, error: targetAliasesError }] =
      await Promise.all([
        supabase.from("community_food_aliases").select("*").eq("community_food_id", sourceFoodId),
        supabase.from("community_food_aliases").select("*").eq("community_food_id", targetFoodId),
      ]);

    if (sourceAliasesError || targetAliasesError) {
      throw new Error(sourceAliasesError?.message ?? targetAliasesError?.message);
    }

    const targetAliasesByNormalized = new Map(
      (targetAliases ?? []).map((alias) => [alias.normalized_alias, alias])
    );
    for (const alias of sourceAliases ?? []) {
      const existing = targetAliasesByNormalized.get(alias.normalized_alias);
      if (existing) {
        const { error } = await supabase
          .from("community_food_aliases")
          .update({ usage_count: existing.usage_count + alias.usage_count })
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
        const { error: deleteError } = await supabase
          .from("community_food_aliases")
          .delete()
          .eq("id", alias.id);
        if (deleteError) throw new Error(deleteError.message);
      } else {
        const { error } = await supabase
          .from("community_food_aliases")
          .update({ community_food_id: targetFoodId })
          .eq("id", alias.id);
        if (error) throw new Error(error.message);
      }
    }

    const { error: votesError } = await supabase
      .from("community_food_votes")
      .update({ community_food_id: targetFoodId })
      .eq("community_food_id", sourceFoodId);
    if (votesError) throw new Error(votesError.message);

    const { error: refreshError } = await supabase.rpc(
      "refresh_community_food_aggregate",
      { food_id: targetFoodId }
    );
    if (refreshError) throw new Error(refreshError.message);

    const after = {
      status: "locked",
      review_required: false,
      reviewed_at: new Date().toISOString(),
      reviewed_by: userId,
    };

    // Single transaction: locking the source food and recording the merge
    // audit row commit together (ADR-009 Task 1 / BUG-04).
    await recordModerationAction(
      supabase,
      sourceFoodId,
      "merged",
      source,
      after,
      target.id
    );
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Merge failed." };
  }
}

async function nextDisplayOrder(
  supabase: Awaited<ReturnType<typeof requireSuperAdmin>>["supabase"],
  table: "food_categories" | "food_subcategories" | "storage_locations",
  filter?: { column: string; value: string }
): Promise<number> {
  let query = supabase
    .from(table)
    .select("display_order")
    .order("display_order", { ascending: false })
    .limit(1);

  if (filter) {
    query = query.eq(filter.column, filter.value);
  }

  const { data } = await query;
  const max = data?.[0]?.display_order ?? 0;
  return max + 10;
}

export async function createFoodCategory(
  name: string,
  icon: string | null
): Promise<CommunityActionResult> {
  try {
    const { supabase } = await requireSuperAdmin();
    const trimmed = name.trim();
    if (!trimmed) {
      return { success: false, error: "Category name is required." };
    }
    const display_order = await nextDisplayOrder(supabase, "food_categories");
    const { error } = await supabase.from("food_categories").insert({
      name: trimmed,
      icon: icon?.trim() || null,
      display_order,
    });
    if (error) throw new Error(error.message);
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not add category.",
    };
  }
}

/**
 * Promote a new subcategory into the controlled vocabulary for a category.
 */
export async function createFoodSubcategory(
  foodCategoryId: string,
  name: string
): Promise<CommunityActionResult> {
  try {
    const { supabase } = await requireSuperAdmin();
    const trimmed = name.trim();
    if (!foodCategoryId || !trimmed) {
      return { success: false, error: "Category and subcategory name are required." };
    }
    const display_order = await nextDisplayOrder(supabase, "food_subcategories", {
      column: "food_category_id",
      value: foodCategoryId,
    });
    const { error } = await supabase.from("food_subcategories").insert({
      food_category_id: foodCategoryId,
      name: trimmed,
      display_order,
    });
    if (error) throw new Error(error.message);
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not add subcategory.",
    };
  }
}

export async function createStorageLocation(
  name: string,
  icon: string | null
): Promise<CommunityActionResult> {
  try {
    const { supabase } = await requireSuperAdmin();
    const trimmed = name.trim();
    if (!trimmed) {
      return { success: false, error: "Storage location name is required." };
    }
    const display_order = await nextDisplayOrder(supabase, "storage_locations");
    const { error } = await supabase.from("storage_locations").insert({
      name: trimmed,
      icon: icon?.trim() || null,
      display_order,
    });
    if (error) throw new Error(error.message);
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Could not add storage location.",
    };
  }
}

export async function setTaxonomyItemActive(
  table: "food_categories" | "food_subcategories" | "storage_locations",
  id: string,
  active: boolean
): Promise<CommunityActionResult> {
  try {
    const { supabase } = await requireSuperAdmin();
    const { error } = await supabase.from(table).update({ active }).eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not update item.",
    };
  }
}

/**
 * Marks a subcategory as an interchangeable ingredient family (e.g. Pasta,
 * Cheese). Recipe/shopping matching treats foods that share a substitutable
 * subcategory as satisfying one another.
 */
export async function setSubcategorySubstitutable(
  id: string,
  substitutable: boolean
): Promise<CommunityActionResult> {
  try {
    const { supabase } = await requireSuperAdmin();
    const { error } = await supabase
      .from("food_subcategories")
      .update({ substitutable })
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePlatform();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Could not update subcategory.",
    };
  }
}
