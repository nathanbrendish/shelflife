"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AI_FEATURE_KEYS, consumeAiQuota, formatRetryAfter } from "@/lib/ai-quota";
import { getGeminiModelName } from "@/lib/gemini/config";
import { mapGeminiError } from "@/lib/gemini/map-gemini-error";
import { parseMealPlanResponse } from "@/lib/gemini/parse-meal-plan";
import {
  buildMealPlanRequest,
  MEAL_PLAN_PROMPT,
} from "@/lib/gemini/planner-prompt";
import { withPlannerGeminiRetry } from "@/lib/gemini/retry";
import { createClient } from "@/lib/supabase/server";
import { triggerShoppingListRegeneration } from "@/app/actions/shopping";
import type { MealPlanItem } from "@/types/v2";

export type GeneratePlanResult =
  | { success: true; planId: string }
  | { success: false; error: string };

export type PlannerActionResult =
  | { success: true }
  | { success: false; error: string };

function isMealPlanParseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("meal plan") ||
      error.message.includes("meals list"))
  );
}

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

export async function getCurrentMealPlan(): Promise<{
  planId: string | null;
  daysCount: number;
  items: MealPlanItem[];
}> {
  const { supabase, user } = await getAuthenticatedUser();

  const { data: plans } = await supabase
    .from("meal_plans")
    .select("id, days_count")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1);

  const plan = plans?.[0];

  if (!plan) {
    return { planId: null, daysCount: 0, items: [] };
  }

  const { data: items } = await supabase
    .from("meal_plan_items")
    .select(
      "id, day_index, sort_order, meal_name, description, ingredients_used, missing_ingredients"
    )
    .eq("plan_id", plan.id)
    .eq("user_id", user.id)
    .order("sort_order", { ascending: true });

  return {
    planId: plan.id,
    daysCount: plan.days_count,
    items: (items ?? []).map((item) => ({
      id: item.id,
      day_index: item.day_index,
      sort_order: item.sort_order,
      meal_name: item.meal_name,
      description: item.description,
      ingredients_used: item.ingredients_used as string[],
      missing_ingredients: item.missing_ingredients as string[],
    })),
  };
}

export async function generateMealPlan(
  daysCount: 3 | 5 | 7
): Promise<GeneratePlanResult> {
  try {
    const { supabase, user } = await getAuthenticatedUser();

    const { data: pantry, error: pantryError } = await supabase
      .from("pantry")
      .select("ingredient_name, expiry_date")
      .eq("user_id", user.id);

    if (pantryError) {
      console.error("[generateMealPlan] pantry fetch failed:", pantryError);
      return {
        success: false,
        error: "Unable to load your pantry. Please try again.",
      };
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: "Meal planner is not configured.",
      };
    }

    // ADR-010 Rule #1: every AI provider call must be preceded by a
    // successful quota consume.
    const quota = await consumeAiQuota(supabase, AI_FEATURE_KEYS.MEAL_PLAN);

    if (!quota.allowed) {
      return {
        success: false,
        error: `You've reached today's meal planning limit. Please try again ${formatRetryAfter(quota.retryAfterSeconds)}.`,
      };
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: getGeminiModelName(),
      systemInstruction: MEAL_PLAN_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const pantryItems = (pantry ?? []).map((item) => ({
      name: item.ingredient_name,
      expiry_date: item.expiry_date as string | null,
    }));

    const meals = await withPlannerGeminiRetry(async () => {
      const result = await model.generateContent(
        buildMealPlanRequest(daysCount, pantryItems)
      );
      const responseText = result.response.text();

      if (!responseText) {
        throw new Error("Gemini returned an empty meal plan response.");
      }

      const parsed = parseMealPlanResponse(responseText, daysCount);

      if (parsed.length === 0) {
        throw new Error("No meals were parsed from the meal plan response.");
      }

      return parsed;
    });

    const items = meals.map((meal, index) => ({
      day_index: meal.dayIndex,
      sort_order: index,
      meal_name: meal.name,
      description: meal.description,
      ingredients_used: meal.ingredientsUsed,
      missing_ingredients: meal.missingIngredients,
    }));

    // Single transaction: delete the old plan and insert the new plan + all
    // its items atomically (ADR-009 Task 3). A failed item insert now rolls
    // back the delete too, so the user is never left planless.
    const { data: planId, error: replaceError } = await supabase.rpc(
      "replace_meal_plan",
      { p_days_count: daysCount, p_items: items }
    );

    if (replaceError || !planId) {
      console.error("[generateMealPlan] replace_meal_plan RPC failed:", replaceError);
      return {
        success: false,
        error: "Failed to save your meal plan. Please try again.",
      };
    }

    try {
      await triggerShoppingListRegeneration();
    } catch (shoppingError) {
      console.error(
        "[generateMealPlan] shopping list regen failed (non-fatal):",
        shoppingError
      );
    }

    revalidatePath("/planner");
    revalidatePath("/dashboard");
    revalidatePath("/shopping");

    return { success: true, planId };
  } catch (error) {
    console.error("[generateMealPlan] failed:", error);

    if (isMealPlanParseError(error)) {
      return {
        success: false,
        error:
          "Unable to read the meal plan from AI. Please try again.",
      };
    }

    const { message } = mapGeminiError(error, "planner");
    return { success: false, error: message };
  }
}

export async function reorderMealPlanItems(
  orderedIds: string[]
): Promise<PlannerActionResult> {
  const { supabase } = await getAuthenticatedUser();

  // Single transaction: apply every sort_order update in one statement
  // (ADR-009 Task 4) instead of N sequential PostgREST requests, so a
  // mid-sequence failure can no longer leave a partially reordered plan.
  const { error } = await supabase.rpc("reorder_meal_plan_items", {
    p_ordered_ids: orderedIds,
  });

  if (error) {
    console.error("[reorderMealPlanItems] reorder_meal_plan_items RPC failed:", error);
    return { success: false, error: "Failed to reorder meals. Please try again." };
  }

  try {
    await triggerShoppingListRegeneration();
  } catch (shoppingError) {
    console.error(
      "[reorderMealPlanItems] shopping list regen failed (non-fatal):",
      shoppingError
    );
  }

  revalidatePath("/planner");
  revalidatePath("/dashboard");

  return { success: true };
}

export async function replaceMealPlanItem(
  itemId: string
): Promise<PlannerActionResult> {
  try {
    const { supabase, user } = await getAuthenticatedUser();

    const { data: item, error: itemError } = await supabase
      .from("meal_plan_items")
      .select("plan_id, day_index")
      .eq("id", itemId)
      .eq("user_id", user.id)
      .single();

    if (itemError || !item) {
      return { success: false, error: "Meal not found." };
    }

    const { data: plan } = await supabase
      .from("meal_plans")
      .select("days_count")
      .eq("id", item.plan_id)
      .single();

    const { data: existingItems } = await supabase
      .from("meal_plan_items")
      .select("meal_name, ingredients_used, missing_ingredients")
      .eq("plan_id", item.plan_id)
      .eq("user_id", user.id);

    const { data: pantry } = await supabase
      .from("pantry")
      .select("ingredient_name, expiry_date")
      .eq("user_id", user.id);

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return { success: false, error: "Meal planner is not configured." };
    }

    // ADR-010 Rule #1: every AI provider call must be preceded by a
    // successful quota consume. `replaceMealPlanItem` shares the
    // `meal_plan` feature key with `generateMealPlan` — both are the
    // "meal planning" entry point per ADR-010's Scope of Application.
    const quota = await consumeAiQuota(supabase, AI_FEATURE_KEYS.MEAL_PLAN);

    if (!quota.allowed) {
      return {
        success: false,
        error: `You've reached today's meal planning limit. Please try again ${formatRetryAfter(quota.retryAfterSeconds)}.`,
      };
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: getGeminiModelName(),
      systemInstruction: MEAL_PLAN_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const existingMeals = (existingItems ?? [])
      .map((entry) => entry.meal_name)
      .join(", ");

    const pantryList = (pantry ?? [])
      .map((entry) => {
        const expiry = entry.expiry_date
          ? ` (expires ${entry.expiry_date})`
          : "";
        return `- ${entry.ingredient_name}${expiry}`;
      })
      .join("\n");

    const prompt = `Create ONE replacement meal for day ${item.day_index + 1}.

Do NOT duplicate these existing meals: ${existingMeals || "none"}.

Pantry:
${pantryList || "None"}

Return JSON with a single meal in the meals array with dayIndex ${item.day_index}.`;

    const replacement = await withPlannerGeminiRetry(async () => {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();

      if (!responseText) {
        throw new Error("Gemini returned an empty replacement meal response.");
      }

      const meals = parseMealPlanResponse(
        responseText,
        plan?.days_count ?? 7
      );
      const meal =
        meals.find((entry) => entry.dayIndex === item.day_index) ?? meals[0];

      if (!meal) {
        throw new Error("No replacement meal was parsed from AI response.");
      }

      return meal;
    });

    const { error: updateError } = await supabase
      .from("meal_plan_items")
      .update({
        meal_name: replacement.name,
        description: replacement.description,
        ingredients_used: replacement.ingredientsUsed,
        missing_ingredients: replacement.missingIngredients,
      })
      .eq("id", itemId)
      .eq("user_id", user.id);

    if (updateError) {
      return { success: false, error: updateError.message };
    }

    try {
      await triggerShoppingListRegeneration();
    } catch (shoppingError) {
      console.error(
        "[replaceMealPlanItem] shopping list regen failed (non-fatal):",
        shoppingError
      );
    }

    revalidatePath("/planner");
    revalidatePath("/shopping");
    revalidatePath("/dashboard");

    return { success: true };
  } catch (error) {
    console.error("[replaceMealPlanItem] failed:", error);

    if (isMealPlanParseError(error)) {
      return {
        success: false,
        error:
          "Unable to read the replacement meal from AI. Please try again.",
      };
    }

    const { message } = mapGeminiError(error, "planner");
    return { success: false, error: message };
  }
}
