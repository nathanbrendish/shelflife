# ADR-005: Semantic Food Matching Instead of String Comparison

**Status:** Accepted  
**Date:** July 2026  
**Deciders:** Engineering lead  
**Repository Path:** `/src/lib/semantic-match.ts`, `/src/lib/food-resolver.ts`, `/src/lib/ingredient-match.ts`

---

## Context

ShelfLife's recipe matching, shopping list computation, and "Add Missing Ingredients" features all require comparing ingredient names between two sources (e.g., recipe ingredients vs. pantry items). Early versions of ShelfLife used normalised string comparison:

```typescript
// Original approach
function ingredientInPantry(name: string, pantry: string[]): boolean {
  const normalised = name.toLowerCase().trim();
  return pantry.some(p => p.toLowerCase().trim() === normalised);
}
```

This caused a class of correctness failures:

| Recipe requires | Pantry contains | Expected result | Actual result (v1) |
|---|---|---|---|
| Macaroni | Pasta | Satisfied (same family) | Missing ❌ |
| Pasta | Macaroni | Satisfied (same family) | Missing ❌ |
| Cheddar | Cheese | Satisfied (same family) | Missing ❌ |
| Fresh Basil | Fresh Basil | Satisfied (exact match) | Missing ❌ (categorised wrongly) |
| Garlic | Onion | Missing (different food) | Missing ✅ |

The "Macaroni / Pasta" problem was identified in QA after Food Knowledge Graph V2 was deployed. The root cause: the Knowledge Graph had the information to resolve both "Macaroni" and "Pasta" to the same canonical food family (Pasta subcategory, `substitutable = true`), but recipe matching was not using it.

A separate bug — "Fresh Basil" being dropped from "Add Missing Ingredients" — was caused by `categorizeIngredient()` emitting "Herbs & Spices" as a category but `SHOPPING_CATEGORIES` not including it. This was a different failure mode (category emission not consumed by UI), but it reinforced the need for a systematic semantic matching approach.

---

## Problem

How should ShelfLife determine whether a recipe ingredient is satisfied by a pantry item?

The options are:
1. **Normalised string comparison** — lowercase, trim, compare
2. **Synonym lists** — hardcoded mappings (Pasta = [Macaroni, Penne, Spaghetti, ...])
3. **Semantic matching via the Food Knowledge Graph** — use canonical IDs and substitutable subcategory families

---

## Decision

**Semantic matching via the Food Knowledge Graph**, implemented as a three-tier comparison cascade in `foodsMatch()`.

### The `foodsMatch()` Function

File: `src/lib/semantic-match.ts`

```typescript
function foodsMatch(
  a: ResolvedFood,
  b: ResolvedFood,
  resolver: FoodResolver
): boolean
```

**Tier 1: Canonical ID match**
If both ingredients resolve to the same `canonical_food_id`, they are the same food.

```
"Mozarella" → canonical_food_id: uuid-mozzarella
"Mozzarella" → canonical_food_id: uuid-mozzarella
→ Match ✅
```

**Tier 2: Substitutable subcategory match**
If both ingredients belong to the same `food_subcategory` where `substitutable = true`, they satisfy each other.

```
"Macaroni" → subcategory_id: uuid-pasta (substitutable: true)
"Pasta"    → subcategory_id: uuid-pasta (substitutable: true)
→ Match ✅ (Macaroni satisfies Pasta requirement)

"Garlic"   → subcategory_id: uuid-alliums (substitutable: false)
"Onion"    → subcategory_id: uuid-alliums (substitutable: false)
→ No match ❌ (Garlic does not satisfy Onion)
```

The `substitutable` flag distinguishes generic families (Pasta, Cheese) from foods that happen to share a category but are not interchangeable.

**Tier 3: Normalised string fallback**
If either ingredient has no canonical ID (e.g., a brand new food not yet in the Knowledge Graph), fall back to normalised string comparison. **Unknown foods are never silently discarded** — they fall through to string comparison.

### The `FoodResolver` Type

```typescript
type FoodResolver = {
  resolve: (name: string) => ResolvedFood;
  substitutableSubcategoryIds: Set<string>;
}
```

`FoodResolver` is a **serializable projection** of the Knowledge Graph for a specific set of ingredient names. It is built once on the server via `buildFoodResolver()` and passed to Client Components as a prop.

### `buildFoodResolver()`

File: `src/lib/food-resolver.ts`

Called on the server (page or Server Action), it:
1. Collects all ingredient names from the context (recipe ingredients + pantry items)
2. Calls `resolve_community_foods` RPC in a single batch query
3. Fetches all substitutable subcategory IDs
4. Returns a `FoodResolver` containing a lookup map and the substitutable subcategory set

### Consumers of `foodsMatch()`

| Consumer | Context |
|---|---|
| `computeShoppingList()` | Shopping demand engine — determines pantry supply for each requirement |
| `matchRecipeToPantry()` | Recipe catalogue — computes pantry match % per recipe |
| `countCookableRecipes()` | Dashboard — counts cookable recipes |
| `rankRecipes()` | Meal suggestions — expiry-aware recipe ranking |
| `ingredientInPantry()` | "Add Missing Ingredients" — determines which ingredients to add |
| `planCookedMealConsumption()` | Cooking completion — matches ingredients to pantry rows to plan deductions (persisted atomically via the `complete_cooked_meal` RPC) |

---

## Alternatives Considered

### Normalised String Comparison Only

```typescript
a.toLowerCase().trim() === b.toLowerCase().trim()
```

| Factor | Assessment |
|---|---|
| Simplicity | Very simple |
| Correctness | Fails for aliases ("Mozarella" ≠ "Mozzarella") and families ("Pasta" ≠ "Macaroni") |
| Maintenance | No — brittle by definition |

Rejected: Demonstrably incorrect. "Macaroni" and "Pasta" are in the same food family. "Mozarella" and "Mozzarella" are the same food. String comparison cannot reason about either.

### Hardcoded Synonym Lists

```typescript
const SYNONYMS: Record<string, string[]> = {
  "pasta": ["macaroni", "penne", "rigatoni", "spaghetti"],
  "cheese": ["cheddar", "mozzarella", "parmesan"],
  // ...
}
```

| Factor | Assessment |
|---|---|
| Coverage | Only covers what the engineering team has manually entered |
| Maintenance | Every new food variant requires a code change and deployment |
| Aliases | Does not handle misspellings or user-entered variants |
| Scalability | Becomes a maintenance burden as the food catalogue grows |
| Community | Bypasses the Knowledge Graph; classifications are duplicated in code |

Rejected: Duplicates the Knowledge Graph in code. Every new food variant requires a deployment. The engineering team cannot maintain coverage for the long tail of food names that receipts produce. The `substitutable` flag in the Knowledge Graph already expresses this information — using it is correct by design.

### Fuzzy String Matching (Levenshtein Distance)

```typescript
levenshtein("macaroni", "pasta") < threshold
```

| Factor | Assessment |
|---|---|
| False positives | "Garlic" is close to "Carlic" (typo) — not the same family as "Parsley" |
| False negatives | "Macaroni" and "Pasta" have low string similarity despite being the same family |
| Threshold sensitivity | No threshold works reliably for both alias matching and family matching |

Rejected: Fuzzy string distance does not capture semantic food relationships. "Macaroni" and "Pasta" have low edit distance similarity. "Garlic" and "Parsley" have higher edit distance similarity than intended matches in many cases.

### LLM-Based Matching on Every Comparison

Ask Gemini "is Macaroni a type of Pasta?" for every ingredient comparison:

| Factor | Assessment |
|---|---|
| Accuracy | High — LLMs understand food relationships |
| Cost | Every comparison triggers an API call; prohibitively expensive |
| Latency | Adds seconds to recipe matching, shopping computation, etc. |
| Determinism | Non-deterministic; same question may get different answers |

Rejected: Cost and latency are prohibitive. The Knowledge Graph already encodes the answer — using an LLM for every comparison is using the right information via the wrong mechanism.

---

## Consequences

### Positive

- "Macaroni" satisfies a "Pasta" recipe requirement — recipe matching is now semantically correct
- "Mozarella" resolves to the same canonical food as "Mozzarella" — alias matching works
- Unknown foods always fall back to string comparison — nothing is silently discarded
- `buildFoodResolver()` batches all Knowledge Graph lookups into one RPC call — no N+1 per ingredient
- The `FoodResolver` is serialisable — it can be passed from Server Component to Client Component as a prop
- `substitutable = false` ensures "Garlic" does not satisfy "Onion" — the flag is explicit and maintainable

### Negative / Trade-offs

- `buildFoodResolver()` requires a round trip to the database before matching can begin
- Foods not yet in the Knowledge Graph fall back to string comparison — a newly scanned receipt item may not benefit from semantic matching until it is classified
- The `substitutable` flag must be carefully curated — incorrectly marking a subcategory as substitutable would cause false "satisfied" results

### Mitigations

- `buildFoodResolver()` is called once per page load / action, not once per ingredient — the cost is O(1) database round trips, not O(N)
- The string fallback ensures correctness for unresolved foods — semantic matching is strictly additive (it can only improve results, not make them worse than string comparison)
- The initial seed data for substitutable families (Pasta, Cheese) is conservative and manually reviewed — new substitutable families require explicit addition to migration 008 or subsequent migrations

---

## The `substitutable` Flag Design

The `substitutable` flag on `food_subcategories` is a first-class design decision:

```sql
ALTER TABLE public.food_subcategories
  ADD COLUMN substitutable boolean NOT NULL DEFAULT false;
```

**Why `false` by default:**  
If a food subcategory has not been explicitly marked as substitutable, it is treated as non-substitutable. This is the safe default — a false negative (Pasta not matching Macaroni for an unmarked subcategory) is better than a false positive (Garlic satisfying Onion).

**Seeded substitutable families (migration 008):**
- Pasta (`substitutable = true`)
- Cheese (`substitutable = true`)

New substitutable families are added via migrations as confidence in the family relationship grows.

---

## Implementation

| File | Purpose |
|---|---|
| `src/lib/semantic-match.ts` | `foodsMatch()`, `matchesAnyPantry()`, `ResolvedFood`, `FoodResolver` types |
| `src/lib/food-resolver.ts` | `buildFoodResolver()` — server-only Knowledge Graph projection builder |
| `src/lib/ingredient-match.ts` | `parseIngredientRequirement()`, `normalizeIngredientForMatch()`, `unitsAreCompatible()` |
| `src/lib/recipe-match.ts` | `matchRecipeToPantry()`, `countCookableRecipes()` — use optional `FoodResolver` |
| `src/lib/recipe-ranking.ts` | `rankRecipes()` — uses optional `FoodResolver` |
| `src/lib/shopping-list.ts` | `computeShoppingList()` — uses `FoodResolver` for demand/supply matching |
| `supabase/migrations/008_semantic_matching.sql` | `substitutable` column, `resolve_community_foods` RPC, Pasta/Cheese seed data |

---

## Future Implications

- New substitutable food families (e.g., Stock / Broth, Flour types) can be added via migrations without code changes
- The `substitutable` flag is currently boolean — a future improvement could be a `substitution_confidence` numeric, allowing partial substitutability
- The string fallback tier could be replaced by a fuzzy/LLM match in the future without changing the consumer API — `foodsMatch()` is the abstraction boundary

---

## Cross References

- [docs/architecture.md — Semantic Matching Engine](../architecture.md)
- [docs/api-reference.md — buildFoodResolver, foodsMatch](../api-reference.md)
- [ADR-004: Community Food Intelligence](./ADR-004-community-food-intelligence.md)
- [ADR-007: Canonical Food Knowledge Graph](./ADR-007-canonical-food-knowledge-graph.md)
