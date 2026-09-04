import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { planMissingIngredientsForShoppingList } from "../src/lib/add-missing-ingredients-core.mjs";

const shoppingListAction = readFileSync(
  new URL("../src/app/actions/shopping-list.ts", import.meta.url),
  "utf8"
);
const shoppingAction = readFileSync(
  new URL("../src/app/actions/shopping.ts", import.meta.url),
  "utf8"
);
const shoppingEngine = readFileSync(
  new URL("../src/lib/shopping-list.ts", import.meta.url),
  "utf8"
);
const shoppingTrip = readFileSync(
  new URL("../src/components/shopping-trip.tsx", import.meta.url),
  "utf8"
);
const shoppingPersistence = readFileSync(
  new URL("../src/lib/shopping-list-persistence.ts", import.meta.url),
  "utf8"
);
const mealsAction = readFileSync(
  new URL("../src/app/actions/meals.ts", import.meta.url),
  "utf8"
);
const pantryConsumption = readFileSync(
  new URL("../src/lib/pantry-consumption.ts", import.meta.url),
  "utf8"
);
const cookingModal = readFileSync(
  new URL("../src/components/cooking-confirmation-modal.tsx", import.meta.url),
  "utf8"
);
const addMissingButton = readFileSync(
  new URL("../src/components/add-missing-to-shopping-button.tsx", import.meta.url),
  "utf8"
);
const sharedMissingSection = readFileSync(
  new URL("../src/components/missing-ingredients-section.tsx", import.meta.url),
  "utf8"
);
const v2Types = readFileSync(
  new URL("../src/types/v2.ts", import.meta.url),
  "utf8"
);
const pantryCategories = readFileSync(
  new URL("../src/lib/pantry-categories.ts", import.meta.url),
  "utf8"
);
const recipeShoppingIngredients = readFileSync(
  new URL("../src/lib/recipe-shopping-ingredients.ts", import.meta.url),
  "utf8"
);

const entryPointFiles = {
  planner: "../src/components/meal-planner.tsx",
  recipePageCard: "../src/components/recipe-catalog.tsx",
  recipeDetail: "../src/components/recipe-detail-modal.tsx",
  mealSuggestionCard: "../src/components/meal-card.tsx",
  savedMeals: "../src/components/saved-meals-list.tsx",
};

function normalizeKey(name) {
  return name.trim().toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
}

function categorizeIngredient(name) {
  const n = name.toLowerCase();
  if (n.includes("basil")) return "Herbs & Spices";
  if (n.includes("garlic")) return "Produce";
  return "Unclassified";
}

function parseIngredient(raw) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)?\s+(.+)$/i);
  if (!match) {
    return { name: trimmed, quantity: null, unit: null };
  }
  return {
    name: match[3].trim(),
    quantity: Number.parseFloat(match[1]),
    unit: match[2]?.toLowerCase() ?? null,
  };
}

function plan(overrides = {}) {
  return planMissingIngredientsForShoppingList({
    ingredients: [],
    pantryNames: [],
    existingShoppingNames: [],
    userId: "user-1",
    normalizeKey,
    parseIngredient,
    isInPantry: () => false,
    categorizeIngredient,
    ...overrides,
  });
}

function exportedFunctionBody(source, functionName) {
  const start = source.indexOf(`export async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);

  const braceStart = source.indexOf("{", start);
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);

  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(braceStart + 1, i);
    }
  }

  assert.fail(`${functionName} body was not closed`);
}

test("recipe-level Add Missing Items never invokes weekly shopping regeneration", () => {
  assert.doesNotMatch(
    shoppingListAction,
    /@\/app\/actions\/shopping/,
    "recipe-level action must not import planner-wide shopping actions"
  );
  assert.doesNotMatch(
    shoppingListAction,
    /regenerateShoppingList|triggerShoppingListRegeneration/,
    "recipe-level action must not regenerate or merge the weekly meal-plan list"
  );
  assert.match(
    shoppingListAction,
    /buildFoodResolver/,
    "recipe-level action should compare recipe ingredients with pantry semantically"
  );
});

test("shopping page read action is read-only and does not regenerate weekly list", () => {
  const body = exportedFunctionBody(shoppingAction, "getShoppingList");

  assert.doesNotMatch(
    body,
    /regenerateShoppingList|triggerShoppingListRegeneration|fetchActivePlanItems|computeShoppingList/,
    "getShoppingList must read persisted rows only"
  );
  assert.match(
    body,
    /\.from\("shopping_list_items"\)/,
    "getShoppingList should fetch the current persisted shopping list"
  );
});

test("multiple missing ingredients are all planned for insertion", () => {
  const result = plan({
    ingredients: ["Garlic", "Fresh Basil"],
  });

  assert.deepEqual(
    result.toInsert.map((item) => item.ingredient_name),
    ["Garlic", "Fresh Basil"]
  );
  assert.equal(result.added, 2);
  assert.equal(result.toInsert[1].category, "Herbs & Spices");
  assert.equal(result.toInsert[0].demand_quantity, 1);
  assert.equal(result.toInsert[0].pantry_quantity, 0);
});

test("recipe Add Missing preserves recipe quantities in shopping rows", () => {
  const result = plan({
    ingredients: ["400g Spaghetti", "500g Beef Mince", "400g Tomatoes"],
  });

  assert.deepEqual(
    result.toInsert.map((item) => item.ingredient_name),
    ["Spaghetti", "Beef Mince", "Tomatoes"]
  );
  assert.deepEqual(
    result.toInsert.map((item) => [item.quantity, item.unit]),
    [
      [400, "g"],
      [500, "g"],
      [400, "g"],
    ]
  );
  assert.deepEqual(
    result.toInsert.map((item) => [item.demand_quantity, item.demand_unit]),
    [
      [400, "g"],
      [500, "g"],
      [400, "g"],
    ]
  );
});

test("semantic match skips ingredients already covered by pantry", () => {
  const result = plan({
    ingredients: ["Pasta"],
    pantryNames: ["Macaroni"],
    isInPantry: (ingredient, pantryNames) =>
      ingredient === "Pasta" && pantryNames.includes("Macaroni"),
  });

  assert.equal(result.added, 0);
  assert.equal(result.skippedPantry, 1);
  assert.deepEqual(result.toInsert, []);
});

test("semantic non-match inserts the missing ingredient", () => {
  const result = plan({
    ingredients: ["Garlic"],
    pantryNames: ["Onion"],
    isInPantry: () => false,
  });

  assert.deepEqual(
    result.toInsert.map((item) => item.ingredient_name),
    ["Garlic"]
  );
});

test("unknown unresolved ingredients fall back to original display name", () => {
  const result = plan({
    ingredients: ["Fresh Basil"],
    isInPantry: () => false,
  });

  assert.equal(result.added, 1);
  assert.equal(result.toInsert[0].ingredient_name, "Fresh Basil");
  assert.equal(result.toInsert[0].category, "Herbs & Spices");
});

test("running Add Missing twice does not create duplicates", () => {
  const first = plan({
    ingredients: ["Garlic", "Fresh Basil"],
  });
  const second = plan({
    ingredients: ["Garlic", "Fresh Basil"],
    existingShoppingNames: first.toInsert.map((item) => item.ingredient_name),
  });

  assert.equal(first.added, 2);
  assert.equal(second.added, 0);
  assert.equal(second.skippedExisting, 2);
});

test("all UI entry points use the shared MissingIngredientsSection", () => {
  assert.match(
    sharedMissingSection,
    /AddMissingToShoppingButton/,
    "shared section should be the only component that renders the add button"
  );
  assert.match(
    addMissingButton,
    /addMissingIngredientsToShoppingList/,
    "shared button should call the canonical server action"
  );

  for (const [name, path] of Object.entries(entryPointFiles)) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(
      source,
      /MissingIngredientsSection/,
      `${name} should use the shared missing-ingredients component`
    );
    assert.doesNotMatch(
      source,
      /addMissingIngredientsToShoppingList|AddMissingToShoppingButton/,
      `${name} should not bypass the shared missing-ingredients component`
    );
  }
});

test("recipe surfaces pass quantity-aware payloads to Add Missing", () => {
  assert.match(
    recipeShoppingIngredients,
    /typical_quantities/,
    "recipe quantity helper should combine recipe quantities with ingredient names"
  );
  for (const path of [
    "../src/components/recipe-catalog.tsx",
    "../src/components/recipe-detail-modal.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /quantityAwareMissingIngredients/);
    assert.match(source, /shoppingIngredients=/);
  }
  assert.match(shoppingListAction, /parseIngredientRequirement/);
});

test("shopping UI renders every category emitted by ingredient categorisation", () => {
  for (const category of [
    "Produce",
    "Meat",
    "Dairy",
    "Bakery",
    "Frozen",
    "Cupboard",
    "Herbs & Spices",
    "Drinks",
    "Unclassified",
  ]) {
    assert.ok(
      pantryCategories.includes(`"${category}"`),
      `${category} should be a possible categorizeIngredient category`
    );
    assert.ok(
      v2Types.includes(`"${category}"`),
      `${category} should be rendered by SHOPPING_CATEGORIES`
    );
  }
});

test("shopping demand engine aggregates quantities and subtracts pantry supply", () => {
  assert.match(
    shoppingEngine,
    /existing\.quantity \+= req\.quantity/,
    "shared ingredient demand should aggregate quantities across meals"
  );
  assert.match(
    shoppingEngine,
    /pantrySupply\.quantity/,
    "shopping requirements should compare against total pantry supply"
  );
  assert.match(
    shoppingEngine,
    /Math\.max\(0, requirement\.quantity - pantrySupply\.quantity\)/,
    "buy quantity should be Demand - Pantry Supply"
  );
  assert.match(
    shoppingEngine,
    /used_by_meals/,
    "shopping demand should preserve expandable meal detail"
  );
});

test("shopping list supports clear all without planner or pantry mutation", () => {
  const body = exportedFunctionBody(shoppingAction, "clearShoppingList");
  assert.match(body, /\.from\("shopping_list_items"\)/);
  assert.match(body, /\.delete\(\)/);
  assert.doesNotMatch(body, /meal_plans|meal_plan_items|\.from\("pantry"\)/);
  assert.match(shoppingTrip, /window\.confirm/);
  assert.match(shoppingTrip, /clearShoppingList/);
});

test("shopping rows persist quantity-aware demand details", () => {
  for (const column of [
    "demand_quantity",
    "demand_unit",
    "pantry_quantity",
    "pantry_unit",
    "used_by_meals",
  ]) {
    assert.ok(
      shoppingAction.includes(column),
      `${column} should be selected and persisted by shopping actions`
    );
    assert.ok(
      v2Types.includes(column),
      `${column} should be exposed on ShoppingListItem`
    );
  }
});

test("shopping insertions use one shared persistence path", () => {
  // Recipe "Add Missing Items" is a simple append and still goes through the
  // shared insert helper.
  assert.match(shoppingPersistence, /export async function insertShoppingListRows/);
  assert.match(shoppingPersistence, /\.from\("shopping_list_items"\)/);
  assert.match(shoppingListAction, /insertShoppingListRows/);
  assert.doesNotMatch(
    shoppingListAction,
    /\.from\("shopping_list_items"\)[\s\S]{0,120}\.insert\(/,
    "recipe Add Missing should not bypass shared insertion helper"
  );

  // Weekly regeneration is a delete-then-insert and must be one atomic
  // transaction (ADR-009 Task 1 / BUG-01), so it goes through the
  // `regenerate_shopping_list` RPC instead of the plain insert helper — never
  // a raw, non-transactional delete/insert pair. Scoped to
  // regenerateShoppingList's own body: clearCheckedItems/clearShoppingList
  // are legitimate single-write actions that do delete directly.
  const regenerateBody = exportedFunctionBody(shoppingAction, "regenerateShoppingList");
  assert.match(regenerateBody, /\.rpc\(\s*"regenerate_shopping_list"/);
  assert.doesNotMatch(
    regenerateBody,
    /\.from\("shopping_list_items"\)[\s\S]{0,200}\.insert\(/,
    "weekly regeneration should persist through the atomic RPC, not a raw insert"
  );
  assert.doesNotMatch(
    regenerateBody,
    /\.from\("shopping_list_items"\)\s*\.delete\(\)/,
    "weekly regeneration should not delete outside the atomic RPC"
  );
});

test("cooking completion uses canonical pantry consumption engine", () => {
  const completeBody = exportedFunctionBody(mealsAction, "completeCookedMeal");
  const cookBody = exportedFunctionBody(mealsAction, "cookMeal");

  // Matching/deduction computation still lives exclusively in
  // pantry-consumption.ts; completeCookedMeal only plans there, then
  // persists the whole result (pantry deductions + observations) in one
  // transaction via the complete_cooked_meal RPC (ADR-009 Task 5 / BUG-03),
  // never through direct, non-transactional pantry writes.
  assert.match(completeBody, /planCookedMealConsumption/);
  assert.match(completeBody, /\.rpc\(\s*"complete_cooked_meal"/);
  assert.match(completeBody, /triggerShoppingListRegeneration/);
  assert.doesNotMatch(completeBody, /\.from\("pantry"\)\s*[\s\S]*\.delete\(\)/);
  assert.doesNotMatch(completeBody, /\.from\("pantry"\)\s*[\s\S]*\.update\(/);
  assert.match(cookBody, /completeCookedMeal/);
  assert.match(pantryConsumption, /foodsMatch/);
  assert.match(pantryConsumption, /unitsAreCompatible/);
});

test("cooking confirmation supports exact, modified, skipped, and extra usage", () => {
  assert.match(cookingModal, /completeCookedMeal/);
  assert.match(cookingModal, /actualQuantity/);
  assert.match(cookingModal, /min="0"/, "quantity zero should be available for skipped ingredients");
  assert.match(cookingModal, /Add extra ingredient/);
  assert.match(pantryConsumption, /"skipped"/);
  assert.match(pantryConsumption, /"extra"/);
});
