# ShelfLife v2 Database Schema Reference

**Classification:** Internal Engineering Reference  
**Version:** 2.0  
**Status:** Current  
**Audience:** Engineers, database administrators, technical reviewers  
**Last Updated:** July 2026  
**See Also:** [docs/architecture.md](./architecture.md) — system design and data flow

---

## Table of Contents

1. [Overview](#1-overview)
2. [Entity Relationship Diagram](#2-entity-relationship-diagram)
3. [Table Reference](#3-table-reference)
   - 3.1 [pantry](#31-pantry)
   - 3.2 [shopping\_list\_items](#32-shopping_list_items)
   - 3.3 [meal\_plans](#33-meal_plans)
   - 3.4 [meal\_plan\_items](#34-meal_plan_items)
   - 3.5 [meals\_saved](#35-meals_saved)
   - 3.6 [community\_foods](#36-community_foods)
   - 3.7 [community\_food\_aliases](#37-community_food_aliases)
   - 3.8 [community\_food\_votes](#38-community_food_votes)
   - 3.9 [community\_food\_moderation\_history](#39-community_food_moderation_history)
   - 3.10 [food\_categories](#310-food_categories)
   - 3.11 [food\_subcategories](#311-food_subcategories)
   - 3.12 [storage\_locations](#312-storage_locations)
   - 3.13 [platform\_roles](#313-platform_roles)
   - 3.14 [user\_roles](#314-user_roles)
   - 3.15 [cooking\_behavior\_observations](#315-cooking_behavior_observations)
4. [Supabase Auth](#4-supabase-auth)
5. [RPC Functions](#5-rpc-functions)
6. [Triggers](#6-triggers)
7. [Indexes](#7-indexes)
8. [Migration Timeline](#8-migration-timeline)
9. [Technical Debt](#9-technical-debt)
10. [Future Schema Improvements](#10-future-schema-improvements)
11. [Production Schema Reconciliation (July 2026)](#11-production-schema-reconciliation-july-2026)

---

## 1. Overview

ShelfLife uses a PostgreSQL database hosted on Supabase. Row Level Security (RLS) is enabled on all application tables. All user data is isolated per `user_id = auth.uid()`.

**Design principles:**
- Community Food Intelligence is the single source of truth for food classification
- The `pantry` table caches classification data for performance; this cache may be stale and is refreshed on page load via `refresh_stale_pantry_classifications()`
- Storage location (`storage_location_id`) is user-owned; the community can never overwrite it
- Food categories and subcategories are a controlled vocabulary (SUPER_ADMIN managed)
- The `cooking_behavior_observations` table is anonymous — no `user_id` column

**All migrations are additive.** No existing migration has been modified since deployment. New columns use `ADD COLUMN IF NOT EXISTS` to prevent conflicts.

**Development is the source of truth.** Production must always remain structurally identical to Development. Migration history (`supabase_migrations.schema_migrations`) records that a migration ran; it does not, by itself, prove the resulting schema is correct or complete — see [Section 11](#11-production-schema-reconciliation-july-2026) for an incident where Production's history and its actual schema diverged for months. Every release now includes a direct, read-only schema comparison between the two databases, not just a migration-history check.

---

## 2. Entity Relationship Diagram

```
auth.users (Supabase managed)
  │
  ├──< pantry (user_id)
  │     ├──> storage_locations (storage_location_id)
  │     ├──> community_foods (canonical_food_id)
  │     ├──> food_categories (cached_category_id)
  │     └──> food_subcategories (cached_subcategory_id)
  │
  ├──< meals_saved (user_id)
  │
  ├──< meal_plans (user_id)
  │     └──< meal_plan_items (plan_id + user_id)
  │
  ├──< shopping_list_items (user_id)
  │
  └──< user_roles (user_id)
        └──> platform_roles (role)

community_foods (autonomous — no user_id)
  ├──> food_categories (food_category_id)
  ├──> food_subcategories (food_subcategory_id)
  ├──< community_food_aliases (community_food_id)
  ├──< community_food_votes (community_food_id)
  │     ├──> food_categories (food_category_id)
  │     ├──> food_subcategories (food_subcategory_id)
  │     └──> storage_locations (storage_location_id)
  └──< community_food_moderation_history (community_food_id)
        ├──> auth.users (actor_user_id)
        └──> community_foods (target_community_food_id — merge target)

food_categories
  └──< food_subcategories (food_category_id)
        └── substitutable: bool (controls semantic matching families)

cooking_behavior_observations (no user_id — anonymous INSERT only)
```

---

## 3. Table Reference

### 3.1 `pantry`

**Purpose:** Per-user pantry items. The primary source of truth for what a user has at home. Classification columns are a cache; the community tables hold the authoritative classification.

**Introduced:** Migration 001  
**Extended by:** Migrations 002, 004, 007, 015. Reconciled on Production by migrations 012, 013, 014 (see [Section 11](#11-production-schema-reconciliation-july-2026)) — no new columns beyond what 004/007 already defined; these migrations recreate the same end-state on Production where it had gone missing. Migration 015 adds the partial unique stacking index.

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `user_id` | uuid | NOT NULL | — | FK → `auth.users(id)` ON DELETE CASCADE |
| `ingredient_name` | text | NOT NULL | — | User-supplied name (preserved, not overwritten by community) |
| `created_at` | timestamptz | NOT NULL | `now()` | |
| `quantity` | numeric | NOT NULL | `1` | Added migration 002 |
| `unit` | text | NULL | — | Added migration 002 |
| `expiry_date` | date | NULL | — | Added migration 002 |
| `updated_at` | timestamptz | NOT NULL | `now()` | Added migration 002 |
| `category` | text | NULL | — | Added migration 004. **DEPRECATED** — no longer written; replaced by `cached_category_id` |
| `subcategory` | text | NULL | — | Added migration 004. **DEPRECATED** — no longer written; replaced by `cached_subcategory_id` |
| `storage_location_id` | uuid | NULL | — | FK → `storage_locations(id)` ON DELETE SET NULL. Added migration 007. User-owned; never overwritten by community data |
| `canonical_food_id` | uuid | NULL | — | FK → `community_foods(id)` ON DELETE SET NULL. Added migration 007. Links to Knowledge Graph |
| `cached_category_id` | uuid | NULL | — | FK → `food_categories(id)` ON DELETE SET NULL. Added migration 007. Cache only |
| `cached_subcategory_id` | uuid | NULL | — | FK → `food_subcategories(id)` ON DELETE SET NULL. Added migration 007. Cache only |
| `classification_version` | bigint | NULL | — | Added migration 007. Compared against `community_foods.classification_version` to detect stale cache |
| `classification_updated_at` | timestamptz | NULL | — | Added migration 007 |

**Primary Key:** `id`  
**Foreign Keys:**
- `user_id` → `auth.users(id)` ON DELETE CASCADE
- `storage_location_id` → `storage_locations(id)` ON DELETE SET NULL
- `canonical_food_id` → `community_foods(id)` ON DELETE SET NULL
- `cached_category_id` → `food_categories(id)` ON DELETE SET NULL
- `cached_subcategory_id` → `food_subcategories(id)` ON DELETE SET NULL

**Indexes:**
- `pantry_items_user_id_idx` ON `(user_id)` — all user-scoped queries
- `pantry_user_storage_idx` ON `(user_id, storage_location_id)` — pantry browser grouping by storage
- `pantry_canonical_food_idx` ON `(canonical_food_id)` — semantic matching
- `pantry_user_canonical_stack_idx` UNIQUE ON `(user_id, canonical_food_id, COALESCE(expiry_date, sentinel), COALESCE(storage_location_id, sentinel), COALESCE(unit, '')) WHERE canonical_food_id IS NOT NULL` — concurrent receipt stacking identity

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Users can view their own pantry items | SELECT | `auth.uid() = user_id` |
| Users can insert their own pantry items | INSERT | `auth.uid() = user_id` |
| Users can update their own pantry items | UPDATE | `auth.uid() = user_id` |
| Users can delete their own pantry items | DELETE | `auth.uid() = user_id` |

**Application usage:**
- Written by: `addIngredient`, `updatePantryItem`, `deleteIngredient` (pantry.ts), `saveScannedIngredients` (receipt.ts, via the `save_scanned_items` RPC), `completeCookedMeal` (meals.ts, via the `complete_cooked_meal` RPC using the plan produced by `planCookedMealConsumption` in pantry-consumption.ts)
- Read by: `regenerateShoppingList`, `getShoppingList` (shopping.ts), `getCatalogueMealSuggestions`, `suggestMeals` (meals.ts), `getDashboardHomeData` (dashboard.ts), `/pantry` page
- Stale cache refreshed by: `refresh_stale_pantry_classifications()` RPC on `/pantry` page load

**Performance notes:** The `pantry_user_storage_idx` composite index enables efficient grouping by storage location in the pantry browser. The `pantry_canonical_food_idx` supports the stacking lookup in `insertOrStackPantryItem`.

---

### 3.2 `shopping_list_items`

**Purpose:** Persisted shopping list. Contains computed quantity demand, pantry supply, and meal attribution for display without recomputation.

**Introduced:** Migration 002  
**Extended by:** Migrations 009, 010

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `user_id` | uuid | NOT NULL | — | FK → `auth.users(id)` ON DELETE CASCADE |
| `ingredient_name` | text | NOT NULL | — | |
| `quantity` | numeric | NULL | — | Buy quantity (demand − supply) |
| `unit` | text | NULL | — | |
| `category` | text | NOT NULL | `'Other'` | Keyword-based category from `categorizeIngredient()` |
| `checked` | boolean | NOT NULL | `false` | User's in-store check state |
| `created_at` | timestamptz | NOT NULL | `now()` | Used for ordering on read |
| `needed_for_meals` | integer | NOT NULL | `1` | Added migration 009. CHECK `>= 1`. Number of planned meals requiring this ingredient |
| `shortage_label` | text | NULL | — | Added migration 009. Human-readable shortage text (may be null) |
| `source` | text | NOT NULL | `'manual'` | Added migration 009. CHECK IN `('manual', 'meal_plan')`. Origin of the row |
| `demand_quantity` | numeric | NULL | — | Added migration 010. Total quantity demanded by meal plan |
| `demand_unit` | text | NULL | — | Added migration 010 |
| `pantry_quantity` | numeric | NULL | — | Added migration 010. Quantity already in pantry at regen time |
| `pantry_unit` | text | NULL | — | Added migration 010 |
| `used_by_meals` | jsonb | NOT NULL | `'[]'` | Added migration 010. Array of meal names using this ingredient |

**Primary Key:** `id`  
**Foreign Keys:**
- `user_id` → `auth.users(id)` ON DELETE CASCADE

**Check Constraints:**
- `needed_for_meals >= 1`
- `source IN ('manual', 'meal_plan')`

**Indexes:**
- `shopping_list_items_user_id_idx` ON `(user_id)`

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Users can manage their own shopping list | ALL | `auth.uid() = user_id` |

**Application usage:**
- Written by: `regenerateShoppingList` (atomic DELETE-all + INSERT via the `regenerate_shopping_list` RPC — [§5.6](#56-transactional-write-boundaries)), `addMissingIngredientsToShoppingList` (INSERT only), `toggleShoppingItem` (UPDATE `checked`), `clearCheckedItems` (DELETE WHERE `checked`), `clearShoppingList` (DELETE all)
- `addMissingIngredientsToShoppingList` inserts through `insertShoppingListRows()` in `shopping-list-persistence.ts`; `regenerateShoppingList` computes its rows in TypeScript and passes them to the `regenerate_shopping_list` RPC, which performs the delete + insert as one transaction
- Read by: `getShoppingList` (SELECT ordered by `created_at`)
- Pages: `/shopping`, `/dashboard` (summary counts only)

**Column lifecycle notes:**
- Pre-migration 009: `needed_for_meals`, `shortage_label`, `source` didn't exist. All rows appeared as manual items.
- Pre-migration 010: Quantity demand details didn't exist. Shopping UI showed simple counts only.

---

### 3.3 `meal_plans`

**Purpose:** Header record for a user's current meal plan. One active plan per user (older plans are deleted on `generateMealPlan`).

**Introduced:** Migration 002

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `user_id` | uuid | NOT NULL | — | FK → `auth.users(id)` ON DELETE CASCADE |
| `days_count` | integer | NOT NULL | — | CHECK IN `(3, 5, 7)` |
| `created_at` | timestamptz | NOT NULL | `now()` | Used to select most recent plan |

**Primary Key:** `id`  
**Foreign Keys:** `user_id` → `auth.users(id)` ON DELETE CASCADE  
**Check Constraints:** `days_count IN (3, 5, 7)`  
**Indexes:** `meal_plans_user_id_idx` ON `(user_id)`

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Users can manage their own meal plans | ALL | `auth.uid() = user_id` |

**Application usage:**
- Written by: `generateMealPlan` (DELETE all + INSERT one), `reorderMealPlanItems` (indirectly via items), `replaceMealPlanItem` (reads plan)
- Read by: `getCurrentMealPlan`, `fetchActivePlanItems` (internal to regenerateShoppingList), `getDashboardHomeData`

---

### 3.4 `meal_plan_items`

**Purpose:** Individual meal slots within a plan. A plan with `days_count = 7` will have 7 items.

**Introduced:** Migration 002

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `plan_id` | uuid | NOT NULL | — | FK → `meal_plans(id)` ON DELETE CASCADE |
| `user_id` | uuid | NOT NULL | — | FK → `auth.users(id)` ON DELETE CASCADE (redundant FK for RLS; plan cascade handles cleanup) |
| `day_index` | integer | NOT NULL | — | Zero-based day number (0 = Day 1) |
| `sort_order` | integer | NOT NULL | `0` | Drag-and-drop order within the plan. Only `sort_order` changes on reorder — `day_index` is immutable post-creation |
| `meal_name` | text | NOT NULL | — | |
| `description` | text | NOT NULL | `''` | |
| `ingredients_used` | jsonb | NOT NULL | `'[]'` | Array of ingredient name strings |
| `missing_ingredients` | jsonb | NOT NULL | `'[]'` | Array of ingredient name strings |

**Primary Key:** `id`  
**Foreign Keys:**
- `plan_id` → `meal_plans(id)` ON DELETE CASCADE
- `user_id` → `auth.users(id)` ON DELETE CASCADE

**Indexes:** `meal_plan_items_plan_id_idx` ON `(plan_id)`

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Users can manage their own meal plan items | ALL | `auth.uid() = user_id` |

**Application usage:**
- Written by: `generateMealPlan` (INSERT batch), `reorderMealPlanItems` (UPDATE `sort_order`), `replaceMealPlanItem` (UPDATE one row)
- Read by: `getCurrentMealPlan`, `fetchActivePlanItems` (internal), `regenerateShoppingList`, `getDashboardHomeData`

---

### 3.5 `meals_saved`

**Purpose:** User-bookmarked meals. Point-in-time snapshots; not re-evaluated against the current pantry.

**Introduced:** Migration 002

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `user_id` | uuid | NOT NULL | — | FK → `auth.users(id)` ON DELETE CASCADE |
| `meal_name` | text | NOT NULL | — | |
| `description` | text | NOT NULL | `''` | |
| `ingredients_used` | jsonb | NOT NULL | `'[]'` | Array of strings |
| `missing_ingredients` | jsonb | NOT NULL | `'[]'` | Array of strings |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**Primary Key:** `id`  
**Foreign Keys:** `user_id` → `auth.users(id)` ON DELETE CASCADE  
**Indexes:** `meals_saved_user_id_idx` ON `(user_id)`

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Users can view their own saved meals | SELECT | `auth.uid() = user_id` |
| Users can insert their own saved meals | INSERT | `auth.uid() = user_id` |
| Users can delete their own saved meals | DELETE | `auth.uid() = user_id` |

**Application usage:**
- Written by: `saveMeal` (INSERT), `removeSavedMeal` (DELETE)
- Read by: `/saved-meals` page, `getDashboardStats` (count only)

---

### 3.6 `community_foods`

**Purpose:** The Knowledge Graph — canonical food records that aggregate all community observations. The single source of truth for food classification, default units, shelf life, and confidence.

**Introduced:** Migration 004  
**Extended by:** Migration 006

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `canonical_name` | text | NOT NULL | — | Human-readable display name |
| `normalized_name` | text | NOT NULL | — | UNIQUE. Result of `community_food_normalize()`. Primary lookup key |
| `primary_category` | text | NULL | — | **DEPRECATED** free-text category (migration 004 era). Use `food_category_id` |
| `secondary_category` | text | NULL | — | **DEPRECATED** free-text subcategory. Use `food_subcategory_id` |
| `food_category_id` | uuid | NULL | — | FK → `food_categories(id)` ON DELETE SET NULL. Added migration 006 |
| `food_subcategory_id` | uuid | NULL | — | FK → `food_subcategories(id)` ON DELETE SET NULL. Added migration 006 |
| `default_unit` | text | NULL | — | Most common unit from votes |
| `default_shelf_life_days` | integer | NULL | — | General shelf life |
| `default_fridge_life_days` | integer | NULL | — | Fridge shelf life |
| `default_freezer_life_days` | integer | NULL | — | Freezer shelf life |
| `usage_count` | integer | NOT NULL | `0` | Total votes. CHECK `>= 0` |
| `alias_count` | integer | NOT NULL | `0` | CHECK `>= 0` |
| `confidence_score` | numeric(5,2) | NOT NULL | `0` | 0–100. CHECK `0–100`. Drives classification tier |
| `status` | text | NOT NULL | `'candidate'` | CHECK IN `('candidate', 'verified', 'locked')` |
| `review_required` | boolean | NOT NULL | `false` | Set true when vote thresholds met; cleared by SUPER_ADMIN moderation |
| `reviewed_at` | timestamptz | NULL | — | |
| `reviewed_by` | uuid | NULL | — | FK → `auth.users(id)` ON DELETE SET NULL |
| `created_at` | timestamptz | NOT NULL | `now()` | |
| `updated_at` | timestamptz | NOT NULL | `now()` | |
| `classification_version` | bigint | NOT NULL | `1` | Added migration 006. Monotonically increasing. Bumped by trigger on classification change |
| `taxonomy_version` | integer | NOT NULL | `1` | Added migration 006 |

**Unique Constraints:**
- `community_foods_normalized_name_key` ON `(normalized_name)`

**Check Constraints:**
- `confidence_score BETWEEN 0 AND 100`
- `usage_count >= 0`, `alias_count >= 0`
- `status IN ('candidate', 'verified', 'locked')`
- Shelf life columns `>= 0`

**Confidence tiers:**
| Score | Tier | Behaviour |
|---|---|---|
| `>= 95` | `verified` | Classification considered definitive |
| `75–94` | `community` | High confidence; community consensus |
| `40–74` | `learning` | Moderate confidence; still learning |
| `< 40` | `unclassified` | `food_category_id` returns NULL in RPCs; UI shows "Unclassified" |

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Super admins can manage community foods | ALL | `is_super_admin()` |

Authenticated users do not have direct table access. Application reads and observations use the granted `SECURITY DEFINER` community-food RPCs, which provide the controlled access boundary.

**Application usage:**
- Written by: `record_community_food_observation` RPC (implicit via learnAndSnapshot), `classify_community_food` RPC, `refresh_community_food_aggregate` RPC
- Read by: `resolve_community_food`, `resolve_community_foods` RPCs
- Linked from: `pantry.canonical_food_id` (cached reference)

---

### 3.7 `community_food_aliases`

**Purpose:** Maps every observed spelling/variant of a food name to its canonical food record. Enables alias resolution — "Mozarella", "Fresh Mozzarella", "Mozzarella Cheese" all resolve to the same canonical food.

**Introduced:** Migration 004

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `community_food_id` | uuid | NOT NULL | — | FK → `community_foods(id)` ON DELETE CASCADE |
| `alias` | text | NOT NULL | — | Original observed text |
| `normalized_alias` | text | NOT NULL | — | UNIQUE. `community_food_normalize()` of `alias` |
| `usage_count` | integer | NOT NULL | `0` | Incremented on each matching observation. CHECK `>= 0` |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**Unique Constraints:** `community_food_aliases_normalized_alias_key` ON `(normalized_alias)`  
**Indexes:** `community_food_aliases_food_id_idx` ON `(community_food_id)`

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Super admins can manage community food aliases | ALL | `is_super_admin()` |

Authenticated users do not have direct table access. Alias reads and writes occur through granted `SECURITY DEFINER` community-food RPCs.

**Application usage:**
- Written by: `record_community_food_observation` RPC (on every pantry add/update/scan)
- Read by: `resolve_community_food`, `resolve_community_foods` RPCs (alias lookup JOIN)
- Managed by: `mergeCommunityFoods` action (migrates aliases between canonical records)

---

### 3.8 `community_food_votes`

**Purpose:** Individual anonymous data points from user observations. Each pantry add/update/scan creates one vote. Aggregated by `refresh_community_food_aggregate` into the `community_foods` record.

**Introduced:** Migration 004  
**Extended by:** Migration 006

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `community_food_id` | uuid | NOT NULL | — | FK → `community_foods(id)` ON DELETE CASCADE |
| `category` | text | NULL | — | **DEPRECATED** free-text category (migration 004 era) |
| `unit` | text | NULL | — | Unit observed |
| `shelf_life_days` | integer | NULL | — | |
| `fridge_days` | integer | NULL | — | |
| `freezer_days` | integer | NULL | — | |
| `created_at` | timestamptz | NOT NULL | `now()` | |
| `food_category_id` | uuid | NULL | — | FK → `food_categories(id)` ON DELETE SET NULL. Added migration 006 |
| `food_subcategory_id` | uuid | NULL | — | FK → `food_subcategories(id)` ON DELETE SET NULL. Added migration 006 |
| `storage_location_id` | uuid | NULL | — | FK → `storage_locations(id)` ON DELETE SET NULL. Added migration 006. Anonymous storage vote |

**Indexes:**
- `community_food_aliases_food_id_idx` (also covers votes via food_id pattern)
- `community_food_votes_storage_idx` ON `(community_food_id, storage_location_id)` — storage suggestion queries

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Super admins can view community food votes | SELECT | `is_super_admin()` |

Authenticated users do not have direct `SELECT` or `INSERT` access. Contributions are inserted through the granted `SECURITY DEFINER` `record_community_food_observation` flow.

**Application usage:**
- Written by: `record_community_food_observation` RPC (implicit, called on every pantry mutation)
- Read by: `refresh_community_food_aggregate` RPC, `get_suggested_storage_location` RPC

---

### 3.9 `community_food_moderation_history`

**Purpose:** Auditable log of all SUPER_ADMIN moderation actions (approve, reject, lock, edit, merge). Stores before/after JSON state for rollback reference.

**Introduced:** Migration 004

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `community_food_id` | uuid | NOT NULL | — | FK → `community_foods(id)` ON DELETE CASCADE |
| `action` | text | NOT NULL | — | CHECK IN `('approved', 'rejected', 'merged', 'locked', 'edited')` |
| `actor_user_id` | uuid | NOT NULL | — | FK → `auth.users(id)` ON DELETE RESTRICT. The moderating SUPER_ADMIN (`auth.uid()` inside the RPC) |
| `target_community_food_id` | uuid | NULL | — | FK → `community_foods(id)` ON DELETE SET NULL. The merge target; populated only by `merged` actions |
| `before_values` | jsonb | NOT NULL | `'{}'` | Snapshot of the food's relevant fields before the action |
| `after_values` | jsonb | NOT NULL | `'{}'` | Snapshot after the action — this is also the partial update applied to `community_foods` |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Super admins can view moderation history | SELECT | `is_super_admin()` |
| Super admins can insert moderation history | INSERT | `is_super_admin()` |

**Application usage:**
- Written by: `approveCommunityFood`, `rejectCommunityFood`, `lockCommunityFoodEntry`, `editCommunityFood`, `mergeCommunityFoods` (community-intelligence.ts) — all via the `moderate_community_food` RPC ([§5.6](#56-transactional-write-boundaries)), which updates `community_foods` and inserts the matching history row in **one transaction** (ADR-009 Task 1 / BUG-04)
- Read by: `getCommunityIntelligenceDashboardData` (last 25 entries)

---

### 3.10 `food_categories`

**Purpose:** Controlled vocabulary for food classification categories. Managed exclusively by SUPER_ADMIN. All classification in the Knowledge Graph references these rows by ID.

**Introduced:** Migration 005

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `name` | text | NOT NULL | — | UNIQUE. e.g. "Dairy", "Vegetables" |
| `icon` | text | NULL | — | Emoji icon for display |
| `display_order` | integer | NOT NULL | `0` | Sort order in UI |
| `active` | boolean | NOT NULL | `true` | Inactive categories hidden from users |
| `taxonomy_version` | integer | NOT NULL | `1` | Incremented when vocabulary changes |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**Seeded categories (17):** Dairy, Fruit, Vegetables, Meat, Seafood, Bakery, Pasta & Rice, Herbs & Spices, Pantry Staples, Condiments & Sauces, Oils & Vinegars, Tinned & Jarred Foods, Frozen Foods, Snacks, Confectionery, Beverages, Baking

**Note:** "Unclassified" is NOT a row. It is represented by `food_category_id = NULL` with `confidence_score < 40`. This prevents "Unclassified" from appearing in analytics as a real category.

**Unique Constraints:** `name` is UNIQUE  
**Indexes:** None beyond the PK

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Authenticated users can view food categories | SELECT | `true` |
| Super admins can manage food categories | ALL | `is_super_admin()` |

**Application usage:**
- Read by: `/pantry` page (for `IngredientFields` dropdown), `/receipt-scanner` page, `buildFoodResolver`, `getCommunityIntelligenceDashboardData`
- Written by: `createFoodCategory`, `setTaxonomyItemActive` (community-intelligence.ts)

---

### 3.11 `food_subcategories`

**Purpose:** Controlled vocabulary for food subcategories. Each belongs to a category. The `substitutable` flag determines whether foods sharing this subcategory are interchangeable in semantic matching.

**Introduced:** Migration 005  
**Extended by:** Migration 008 (`substitutable` column)

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `food_category_id` | uuid | NOT NULL | — | FK → `food_categories(id)` ON DELETE CASCADE |
| `name` | text | NOT NULL | — | e.g. "Cheese", "Pasta", "Leafy Greens" |
| `icon` | text | NULL | — | |
| `display_order` | integer | NOT NULL | `0` | |
| `active` | boolean | NOT NULL | `true` | |
| `taxonomy_version` | integer | NOT NULL | `1` | |
| `created_at` | timestamptz | NOT NULL | `now()` | |
| `substitutable` | boolean | NOT NULL | `false` | Added migration 008. When true, any food in this subcategory satisfies any other food in the same subcategory in recipe matching and shopping demand |

**Unique Constraints:** `food_subcategories_category_name_key` ON `(food_category_id, name)`  
**Indexes:**
- `food_subcategories_category_idx` ON `(food_category_id)`

**Substitutable subcategories (seeded):**
| Category | Subcategory | Meaning |
|---|---|---|
| Pasta & Rice | Pasta | Macaroni / Penne / Spaghetti / Rigatoni are interchangeable |
| Dairy | Cheese | Cheddar / Mozzarella / Parmesan / Feta are interchangeable |

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Authenticated users can view food subcategories | SELECT | `true` |
| Super admins can manage food subcategories | ALL | `is_super_admin()` |

**Application usage:**
- Read by: `buildFoodResolver` (SELECT WHERE `substitutable = true`), `/pantry` page, platform dashboard
- Written by: `createFoodSubcategory`, `setTaxonomyItemActive`, `setSubcategorySubstitutable` (community-intelligence.ts)

**Semantic matching impact:** Modifying `substitutable` via the platform dashboard immediately changes recipe matching and shopping demand behaviour for all users. Changes take effect on the next `buildFoodResolver` call.

---

### 3.12 `storage_locations`

**Purpose:** Controlled vocabulary for storage locations. User-owned — the community can suggest but never overwrite a user's storage choice.

**Introduced:** Migration 005

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `name` | text | NOT NULL | — | UNIQUE. e.g. "Fridge", "Freezer", "Cupboard" |
| `icon` | text | NULL | — | Emoji icon |
| `display_order` | integer | NOT NULL | `0` | |
| `active` | boolean | NOT NULL | `true` | |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**Seeded locations (6):** Fridge, Freezer, Cupboard, Pantry, Drinks Cabinet, Cellar

**Unique Constraints:** `name` is UNIQUE  

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Authenticated users can view storage locations | SELECT | `true` |
| Super admins can manage storage locations | ALL | `is_super_admin()` |

**Application usage:**
- Read by: `IngredientFields` (dropdown in add form and receipt review), `getCommunityFoodDefaults` (for suggested location), platform dashboard
- Written by: `createStorageLocation`, `setTaxonomyItemActive` (community-intelligence.ts)
- Referenced by: `community_food_votes.storage_location_id` (anonymous storage votes), `pantry.storage_location_id` (user choice)

---

### 3.13 `platform_roles`

**Purpose:** Lookup table of valid platform roles. Values: `USER`, `SUPER_ADMIN`.

**Introduced:** Migration 004

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `role` | text | NOT NULL | — | Primary key. CHECK format `^[A-Z][A-Z0-9_]{1,63}$` |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**Check Constraints:** `role ~ '^[A-Z][A-Z0-9_]{1,63}$'`

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Authenticated users can view platform role definitions | SELECT | `true` |

**Application usage:** Referenced by `user_roles.role`. Read by platform auth logic in `src/lib/platform-auth.ts`.

---

### 3.14 `user_roles`

**Purpose:** Maps users to platform roles. A user with no row has no special role (treated as `USER`). A row with `role = 'SUPER_ADMIN'` grants access to the platform administration dashboard.

**Introduced:** Migration 004

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `user_id` | uuid | NOT NULL | — | FK → `auth.users(id)` ON DELETE CASCADE |
| `role` | text | NOT NULL | — | FK → `platform_roles(role)` ON UPDATE CASCADE |
| `assigned_by` | uuid | NULL | — | FK → `auth.users(id)` ON DELETE SET NULL |
| `assigned_at` | timestamptz | NOT NULL | `now()` | |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**Unique Constraints:** `user_roles_user_role_key` ON `(user_id, role)`  
**Indexes:**
- `user_roles_user_id_idx` ON `(user_id)`
- `user_roles_role_idx` ON `(role)`

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Users can view their own roles | SELECT | `user_id = auth.uid() OR is_super_admin()` |
| Super admins can manage user roles | ALL | `is_super_admin()` |

**Application usage:**
- Read by: `is_super_admin()` function (SECURITY DEFINER), `requireSuperAdmin()` in `platform-auth.ts`
- No UI for assigning roles — must be done via Supabase Dashboard or direct SQL

---

### 3.15 `cooking_behavior_observations`

**Purpose:** Anonymous record of expected-vs-actual ingredient usage when a user confirms a cooked meal. No `user_id` column — data is intentionally disconnected from individual users. Used for future cooking intelligence and personalisation.

**Introduced:** Migration 011

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` | Primary key |
| `recipe_id` | text | NULL | — | Reference to the catalogue recipe ID (if from a known recipe) |
| `recipe_name` | text | NOT NULL | — | Denormalised for readability |
| `expected_ingredient` | text | NULL | — | Ingredient as the recipe specified |
| `actual_ingredient` | text | NOT NULL | — | Ingredient as the user actually used |
| `expected_quantity` | numeric | NULL | — | |
| `expected_unit` | text | NULL | — | |
| `actual_quantity` | numeric | NOT NULL | `0` | CHECK `>= 0`. Zero = skipped |
| `actual_unit` | text | NULL | — | |
| `action` | text | NOT NULL | `'used'` | CHECK IN `('used', 'skipped', 'extra', 'substituted')` |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**Check Constraints:**
- `actual_quantity >= 0`
- `action IN ('used', 'skipped', 'extra', 'substituted')`

**RLS Policies:**
| Policy | Operation | Condition |
|---|---|---|
| Authenticated users can record anonymous cooking observations | INSERT | `true` (all authenticated) |

**Note:** There is deliberately no SELECT policy for regular users. The data is insert-only from the application perspective. SUPER_ADMIN access is via service role or direct database access.

**Application usage:**
- Written by: `completeCookedMeal` (meals.ts) via the `complete_cooked_meal` RPC, using the observation rows computed by `planCookedMealConsumption` in `pantry-consumption.ts`
- Read by: Not currently read by any application code. Reserved for future analytics

**Action values:**
| Action | Meaning |
|---|---|
| `used` | Standard usage matching recipe |
| `skipped` | `actual_quantity = 0`; ingredient omitted |
| `extra` | Ingredient not in original recipe |
| `substituted` | `expected_ingredient != actual_ingredient` |

---

## 4. Supabase Auth

Supabase manages `auth.users` internally. The application does not have direct schema access.

**User metadata stored at registration:**
```json
{
  "display_name": "Nathan",
  "full_name": "Nathan"
}
```

**Auth flows:**
| Flow | Mechanism |
|---|---|
| Email/password login | `supabase.auth.signInWithPassword` |
| Registration | `supabase.auth.signUp` with `emailRedirectTo: ${getSiteUrl()}/auth/callback` |
| Email confirmation | Token exchange at `/auth/callback` |
| Password reset | `resetPasswordForEmail` → email → `/auth/callback?next=/reset-password` |
| Session refresh | Automatic via middleware (`updateSession` in `src/lib/supabase/middleware.ts`) |
| Account deletion | `delete_user_account()` SECURITY DEFINER function deletes from `auth.users`; all cascade |

---

## 5. RPC Functions

All functions are in the `public` schema. Grant targets are `authenticated` unless noted.

### 5.1 Identity and Roles

| Function | Returns | Purpose |
|---|---|---|
| `is_platform_role(required_role text)` | boolean | Returns true if `auth.uid()` has the given role |
| `is_super_admin()` | boolean | Convenience wrapper for `is_platform_role('SUPER_ADMIN')` |

Both are STABLE, SECURITY DEFINER with `search_path = public`.

---

### 5.2 Account Management

| Function | Returns | Purpose |
|---|---|---|
| `delete_user_account()` | void | SECURITY DEFINER. Deletes `auth.users` row for `auth.uid()`. All user data cascades |

---

### 5.3 Community Food Intelligence

| Function | Signature | Returns | Purpose |
|---|---|---|---|
| `community_food_normalize(value text)` | `(text)` | text | Lowercases, trims, strips punctuation. Used to generate `normalized_name` and `normalized_alias` |
| `community_food_tier(confidence numeric)` | `(numeric)` | text | Returns `'verified'/'community'/'learning'/'unclassified'` |
| `community_food_category_agreement(food_id uuid, expected uuid)` | `(uuid, uuid)` | numeric | % of votes that agree with a given category |
| `community_food_agreement(food_id uuid, field text, expected_value text)` | `(uuid, text, text)` | numeric | % agreement for any field (unit, shelf_life_days) |
| `refresh_community_food_aggregate(food_id uuid)` | `(uuid)` | void | Recomputes `confidence_score`, `food_category_id`, `food_subcategory_id`, `default_unit`, usage/alias counts. Called after every vote |
| `record_community_food_observation(...)` | many params | TABLE `(resolved_food_id, resolved_confidence, resolved_version)` | Upserts canonical food, adds alias, inserts vote, calls aggregate refresh |
| `classify_community_food(observed_name, category_id, subcategory_id)` | 3 params | TABLE | Calls `record_community_food_observation` with explicit category IDs |
| `get_community_classifications(food_ids uuid[])` | `(uuid[])` | TABLE | Batch classification lookup for known food IDs |
| `resolve_community_food(search_name text)` | `(text)` | TABLE | Resolve one name → canonical food + effective classification + storage suggestion |
| `get_suggested_storage_location(search_name text)` | `(text)` | uuid | Most common storage location voted for this food |

---

### 5.4 Batch Resolver

| Function | Signature | Returns | Purpose |
|---|---|---|---|
| `resolve_community_foods(search_names text[])` | `(text[])` | TABLE `(input_name, canonical_food_id, food_category_id, food_subcategory_id)` | Batch resolve. Used by `buildFoodResolver` to build the entire Food Resolver in one round-trip |

---

### 5.5 Pantry Cache Maintenance

| Function | Signature | Returns | Purpose |
|---|---|---|---|
| `refresh_stale_pantry_classifications()` | `()` | integer | Updates `cached_category_id`, `cached_subcategory_id`, `classification_version` for rows where `community_foods.classification_version > pantry.classification_version`. Returns count of rows updated. Called on every `/pantry` page load |

---

### 5.6 Transactional Write Boundaries

Introduced by migration 015 under [ADR-009](./adr/ADR-009-transactional-write-patterns.md). Each function is `SECURITY DEFINER`, fixes its `search_path` to `public`, derives the caller from `auth.uid()`, and commits or rolls back its dependent writes as one PostgreSQL transaction.

| Function | Signature | Returns | Atomic operation |
|---|---|---|---|
| `moderate_community_food` | `(text, uuid, jsonb, jsonb, uuid)` | void | Updates a community food and inserts its moderation-history record |
| `regenerate_shopping_list` | `(jsonb)` | `SETOF shopping_list_items` | Replaces the caller's persisted shopping list |
| `replace_meal_plan` | `(integer, jsonb)` | uuid | Replaces the caller's plan header and plan items |
| `reorder_meal_plan_items` | `(jsonb)` | void | Updates all supplied meal-plan sort positions |
| `complete_cooked_meal` | `(jsonb, jsonb)` | void | Applies pantry deductions and inserts cooking observations |
| `save_scanned_items` | `(jsonb)` | void | Applies a receipt batch using the precomputed stacking plan |

`save_scanned_items` is protected by `pantry_user_canonical_stack_idx`, whose identity includes `COALESCE(unit, '')`. Concurrent rows with the same raw stacking identity are merged by summing quantity; empty-string units are normalized to `NULL` at the RPC boundary.

---

## 6. Triggers

### `community_foods_classification_version` (BEFORE UPDATE)

**Table:** `community_foods`  
**Function:** `community_foods_bump_classification_version()`  
**Introduced:** Migration 006

Fires before every UPDATE on `community_foods`. Increments `classification_version` only if one of these fields changed:
- `food_category_id`
- `food_subcategory_id`
- `confidence_score`
- `status`

This selective bump means unrelated field updates (e.g. incrementing `usage_count`) do not invalidate pantry caches unnecessarily.

---

## 7. Indexes

| Index | Table | Columns | Purpose |
|---|---|---|---|
| `pantry_items_user_id_idx` | `pantry` | `(user_id)` | All user-scoped pantry queries |
| `pantry_user_storage_idx` | `pantry` | `(user_id, storage_location_id)` | Pantry browser grouped by storage location |
| `pantry_canonical_food_idx` | `pantry` | `(canonical_food_id)` | `insertOrStackPantryItem` stacking lookup |
| `pantry_user_canonical_stack_idx` | `pantry` | User, canonical food, expiry, storage, raw unit (null-safe) | Partial unique index used by `save_scanned_items` to merge concurrent identical stacking identities |
| `meals_saved_user_id_idx` | `meals_saved` | `(user_id)` | |
| `meal_plans_user_id_idx` | `meal_plans` | `(user_id)` | |
| `meal_plan_items_plan_id_idx` | `meal_plan_items` | `(plan_id)` | |
| `shopping_list_items_user_id_idx` | `shopping_list_items` | `(user_id)` | |
| `user_roles_user_id_idx` | `user_roles` | `(user_id)` | RLS performance |
| `user_roles_role_idx` | `user_roles` | `(role)` | Role lookup |
| `community_food_aliases_food_id_idx` | `community_food_aliases` | `(community_food_id)` | Alias resolution JOIN |
| `community_foods_food_category_idx` | `community_foods` | `(food_category_id)` | Category-based queries |
| `community_food_votes_storage_idx` | `community_food_votes` | `(community_food_id, storage_location_id)` | Storage suggestion mode |
| `community_food_votes_food_id_idx` | `community_food_votes` | `(community_food_id)` | Aggregate refresh lookups |
| `community_food_votes_food_created_at_idx` | `community_food_votes` | `(community_food_id, created_at DESC)` | Recent votes for a food |
| `community_food_aliases_usage_count_idx` | `community_food_aliases` | `(usage_count DESC)` | Popular alias ranking |
| `community_food_moderation_history_food_idx` | `community_food_moderation_history` | `(community_food_id, created_at DESC)` | Moderation history lookups |
| `food_subcategories_category_idx` | `food_subcategories` | `(food_category_id)` | |

All indexes above were confirmed present on both Development and Production as of the July 2026 reconciliation (Section 11); those missing from Production were recreated by migration 013 using `CREATE INDEX IF NOT EXISTS`.

---

## 8. Migration Timeline

| Migration | File | Introduced | Purpose |
|---|---|---|---|
| 001 | `001_pantry_items.sql` | v1 | Creates `pantry` table with `id`, `user_id`, `ingredient_name`, `created_at`. RLS enabled |
| 002 | `002_v2_features.sql` | v1 | Adds `quantity`, `unit`, `expiry_date`, `updated_at` to `pantry`. Creates `meals_saved`, `meal_plans`, `meal_plan_items`, `shopping_list_items` |
| 003 | `003_delete_account.sql` | v1 | Adds `delete_user_account()` SECURITY DEFINER function |
| 004 | `004_community_food_intelligence.sql` | v2 | Adds `category`, `subcategory` to `pantry` (deprecated). Creates `platform_roles`, `user_roles`, `community_foods`, `community_food_aliases`, `community_food_votes`, `community_food_moderation_history`. Adds RPCs for observation, classification, resolution |
| 005 | `005_food_taxonomy.sql` | v2 | Creates `food_categories`, `food_subcategories`, `storage_locations` with seed data |
| 006 | `006_community_classification.sql` | v2 | Adds `food_category_id`, `food_subcategory_id`, `classification_version`, `taxonomy_version` to `community_foods` and `community_food_votes`. Adds `storage_location_id` to votes. Adds classification version trigger. Rewrites RPCs to use IDs |
| 007 | `007_pantry_storage_and_cache.sql` | v2 | Adds `storage_location_id`, `canonical_food_id`, `cached_category_id`, `cached_subcategory_id`, `classification_version`, `classification_updated_at` to `pantry`. Adds `refresh_stale_pantry_classifications()` RPC |
| 008 | `008_semantic_matching.sql` | v2 | Adds `substitutable` to `food_subcategories`. Adds `resolve_community_foods(text[])` batch RPC. Seeds 17 pasta and cheese variant records |
| 009 | `009_shopping_list_metadata.sql` | v2 | Adds `needed_for_meals`, `shortage_label`, `source` to `shopping_list_items` |
| 010 | `010_shopping_demand_details.sql` | v2 | Adds `demand_quantity`, `demand_unit`, `pantry_quantity`, `pantry_unit`, `used_by_meals` to `shopping_list_items` |
| 011 | `011_cooking_behavior_observations.sql` | v2 | Creates `cooking_behavior_observations` table (anonymous, INSERT-only) |
| 012 | `012_reconcile_production_schema.sql` | Post-v2.0 maintenance | Reconciles `pantry`'s migration 004 (`category`, `subcategory`) and migration 007 (storage/classification cache columns, FKs, indexes, `refresh_stale_pantry_classifications()`) end-state on Production. Its FK targets are ordinarily created by migrations 004/005; the July 2026 drift incident required migration 013 to recreate those missing objects before 012 could execute — see [Section 11](#11-production-schema-reconciliation-july-2026) |
| 013 | `013_reconcile_production_to_development.sql` | Post-v2.0 maintenance | Comprehensive, additive, idempotent reconciliation of all schema drift found by forensic audit: 10 missing tables, 16 missing `pantry`/`shopping_list_items` columns, 4 missing FKs, 13 missing indexes, 15 missing functions, 1 missing trigger, 3 renamed `pantry` RLS policies, plus seed/reference data. A no-op on Development |
| 014 | `014_defensive_pantry_prerequisite_guard.sql` | Post-v2.0 maintenance | Forward-only hardening of migration 012: restates its four FK-bearing `pantry` columns so each is only added if its referenced table exists, instead of raising an error. Does not edit 012 |
| 015 | `015_transactional_write_rpcs.sql` | ADR-009 Phase 1 | Adds six transactional write RPCs and the `pantry_user_canonical_stack_idx` partial unique index. Converts multi-request write sequences into atomic database operations |

---

## 9. Technical Debt

| Issue | Location | Risk | Notes |
|---|---|---|---|
| Deprecated `category`/`subcategory` columns on `pantry` | `pantry` table | Low | Added migration 004, deprecated migration 007. Still present in schema. A cleanup migration to `DROP COLUMN` these has not been created |
| Deprecated `primary_category`/`secondary_category` on `community_foods` | `community_foods` table | Low | Free-text columns from migration 004. Superseded by `food_category_id` in migration 006 |
| Deprecated `category` on `community_food_votes` | `community_food_votes` table | Low | Free-text column from migration 004 |
| No read SELECT RLS policy on `cooking_behavior_observations` | `cooking_behavior_observations` | Low | By design — data is write-only from app layer. Would need service role for analytics |
| Compatible units with different raw strings can form separate stacks under cross-request concurrency (BUG-05) | `save_scanned_items` / `pantry_user_canonical_stack_idx` | Low | The index safely merges identical raw-unit identities, but concurrent compatible synonyms such as `L` and `litre` can pass separate TypeScript snapshots and remain separate rows. No quantity is lost. Deferred to Phase 2; see [Section 10](#10-future-schema-improvements) |
| User roles must be assigned via database dashboard | `user_roles` | Medium | No UI for assigning SUPER_ADMIN. Requires direct SQL or Supabase dashboard access |
| `shopping_list_items.category` defaults to `'Other'` | `shopping_list_items` | Low | Migration 002 default. Category now uses `categorizeIngredient()` at write time; legacy rows with `'Other'` may exist |
| `public.pantry_items` exists only on Production | `pantry_items` table | Low (data), Medium (confusion risk) | Legacy artifact from before migration 001's table was renamed `pantry_items` → `pantry`; applied to Production before that rename with no corresponding rename ever migrated. Not referenced anywhere in `src/`. Deliberately left untouched by the July 2026 reconciliation — see [Section 11](#11-production-schema-reconciliation-july-2026). Removal requires a separate, explicitly reviewed migration since it may hold real historical rows |
| Migration 012 requires its FK-referenced tables to exist at execution time | `012_reconcile_production_schema.sql` | Low | This is a drifted-history limitation: 012 fails when migrations 004–011 are recorded as applied but their prerequisite objects are absent, as in the July 2026 Production incident. It does not fail on a clean, ordered replay because migrations 004/005/007 create the prerequisites before 012 runs. A from-scratch `supabase db reset` (001→014) succeeds, and the migration-chain CI job now verifies this on every PR. See [Section 11](#11-production-schema-reconciliation-july-2026) and [ADR-008](./adr/ADR-008-production-schema-reconciliation-strategy.md) |

---

## 10. Future Schema Improvements

> Status is explicit: future items are not implemented unless marked **DONE**.

| Improvement | Rationale |
|---|---|
| **DONE — FUP-1: sum quantities on a stacking conflict** | Migration 015 uses `quantity = pantry.quantity + EXCLUDED.quantity` in `save_scanned_items`; integration tests verify retries/concurrent identity conflicts preserve both quantities |
| **Phase 2 — BUG-05: compatible-but-different raw-unit concurrency** | Cross-request inserts such as `L` and `litre` can miss TypeScript's pre-write merge and use distinct database identity keys. No data is lost, but quantities may remain in separate rows. Requires a canonical-unit concurrency design |
| DROP deprecated text columns | Clean up `pantry.category`, `pantry.subcategory`, `community_foods.primary_category`, etc. after verifying no queries reference them |
| Add `user_id` to `cooking_behavior_observations` as optional | Would enable per-user cooking personalisation without making all data personally identifiable |
| Normalise `meal_plan_items.ingredients_used` | Currently JSONB arrays. Normalised junction table would allow ingredient-level querying |
| Partial index on `community_foods` for `review_required = true` | Would speed up the moderation queue query |
| Add `updated_at` to `shopping_list_items` | Useful for incremental sync if a mobile client is added |
| `storage_location_id` on `shopping_list_items` | Would allow "buy for Fridge" shopping organisation |
| DROP `public.pantry_items` | Legacy table, Production only, unreferenced by the app. Requires a separate, explicitly reviewed migration (see [Section 11](#11-production-schema-reconciliation-july-2026)) — not appropriate for an additive reconciliation migration |

---

## 11. Production Schema Reconciliation (July 2026)

### 11.1 Summary

Production began raising `Could not find the 'cached_category_id' column of 'pantry' in the schema cache` at runtime. Investigation found that Production's `supabase_migrations.schema_migrations` table reported migrations 001–011 as fully applied, but a forensic, read-only audit — direct introspection of both databases' `information_schema` and `pg_catalog` (tables, columns, types, defaults, PKs, FKs, unique/check constraints, indexes, functions, triggers, RLS state, policies, grants) — found the actual Production schema did not match what those migrations should have produced.

### 11.2 Root Cause

Migration history had been trusted as evidence of schema state. It was wrong: Production's history claimed 011 migrations had run successfully, but the objects several of them define were never materialized there. No corruption or manual tampering was found — the most likely explanation is that some migrations were recorded as applied (e.g. via an interrupted or partially-failed `db push`, or an out-of-band history correction) without every one of their statements actually completing against Production.

### 11.3 Forensic Findings

| Category | Missing on Production |
|---|---|
| Tables | `food_categories`, `food_subcategories`, `storage_locations`, `platform_roles`, `user_roles`, `community_foods`, `community_food_aliases`, `community_food_votes`, `community_food_moderation_history`, `cooking_behavior_observations` (10 tables) |
| Functions | 15 of 16 (only `delete_user_account()` existed) |
| Triggers | `community_foods_classification_version` (the only trigger in the schema) |
| `pantry` columns | `category`, `subcategory` (migration 004); `storage_location_id`, `canonical_food_id`, `cached_category_id`, `cached_subcategory_id`, `classification_version`, `classification_updated_at` (migration 007) — 8 columns |
| `shopping_list_items` columns | `needed_for_meals`, `shortage_label`, `source` (migration 009); `demand_quantity`, `demand_unit`, `pantry_quantity`, `pantry_unit`, `used_by_meals` (migration 010) — 8 columns |
| Foreign keys | All 4 reconciled `pantry` FKs (migration 007) |
| Indexes | 13, across `pantry` and the missing tables |
| RLS policies | `pantry`'s 3 policies existed but under different names than Development's (same `auth.uid() = user_id` logic, different labels) |
| Extra on Production only | `public.pantry_items` — legacy table not present in Development at all (see [Section 9](#9-technical-debt)) |

### 11.4 Reconciliation Strategy

Two new, additive, idempotent migrations were written directly from Development's live, introspected schema (not replayed from historical migration source, to guarantee byte-for-byte fidelity with what Development actually runs today):

- **`013_reconcile_production_to_development.sql`** — recreates every missing table (with all constraints inline), adds every missing column/FK/index to `pantry` and `shopping_list_items`, renames the 3 divergently-named `pantry` policies, recreates all 15 missing functions (function bodies extracted via `pg_get_functiondef()` for exact fidelity) and the 1 missing trigger, enables RLS and creates policies on every new table, grants `EXECUTE` to `authenticated` on every function, and seeds reference data (food categories, subcategories, storage locations, platform roles, starter Knowledge Graph entries) using `ON CONFLICT DO NOTHING`. Every statement uses `IF NOT EXISTS` / `CREATE OR REPLACE` / a guarded existence check, so the entire migration is a no-op on Development. Concludes with a post-flight verification block that rolls back the whole transaction if any expected object is still missing or malformed after it runs.
- **`014_defensive_pantry_prerequisite_guard.sql`** — see [11.5](#115-migration-014-why-it-exists) below.

**Deployment sequencing constraint:** because Supabase migrations apply strictly in filename order and abort the entire batch on the first failure, `012_reconcile_production_schema.sql` (written in an earlier investigation, before the full extent of drift was known) ran before 013 and immediately failed with `relation "public.storage_locations" does not exist` — it adds FK-bearing `pantry` columns assuming their referenced tables already exist, which was not yet true on Production. The failure rolled back cleanly with zero side effects (verified: Production's history and `pantry` column count were unchanged afterward).

Fixing this required either editing migration 012 or using `supabase migration repair` to mark it applied without running it — both are permanently out of bounds (see [Section 11.6](#116-lessons-and-permanent-rules)). Instead, migration 013's own SQL — already validated as idempotent — was applied directly and honestly against Production first (via a one-time, explicit, out-of-band execution, wrapped in its own transaction), which genuinely created the missing prerequisite tables. The normal `supabase db push` was then run: 012 now succeeded for real (its targets existed), 013 succeeded again idempotently, and 014 succeeded as a no-op — all three genuinely executed and correctly recorded in `schema_migrations`. No history was faked; every recorded version's SQL actually ran.

### 11.5 Migration 014: Why It Exists

**Purpose:** a permanent, forward-only defensive hardening of migration 012's undeclared prerequisite dependency.

**Reason it exists:** migration 012 validates the `REFERENCES` target of each FK-bearing `pantry` column at `ALTER TABLE` execution time, regardless of the column's own `IF NOT EXISTS` guard. If the referenced table (`storage_locations`, `community_foods`, `food_categories`, `food_subcategories`) does not exist yet, 012 fails outright and aborts its whole transaction — which is exactly what happened on Production's first real deployment attempt.

**Relationship with migration 012:** 014 does not edit, replace, or supersede 012. It is a separate, additive migration that restates the same four column additions defensively: each is only added, together with its foreign key (`NOT VALID` + `VALIDATE CONSTRAINT`, matching 012's locking-safety pattern), if `to_regclass()` confirms its referenced table exists; otherwise that one column is skipped with a `RAISE NOTICE` instead of an error. It is a pure no-op wherever 012 (or 013) already completed successfully — including Development today.

**Correction — 13 July 2026:** the original incident narrative is retained above, but a later claim that migration 012 cannot succeed on a from-scratch replay was incorrect. Migration 012 fails only when its FK-referenced tables are absent at execution time — under drifted or partially-applied migration history, as in the July 2026 Production incident where migrations 004–011 were recorded as applied but their objects were missing. It does not fail on a clean, ordered replay: migrations 004/005/007 create those prerequisites before 012 runs. A from-scratch `supabase db reset` (001→014) succeeds, and the migration-chain CI job introduced under ADR-009 now verifies this on every PR. The incorrect claim generalized an assumption from the Production incident without empirical testing; Development had reached its state through manual pre-application, not a clean replay. This reinforces ADR-008's central lesson: history and prose are not proof—verify schema behavior directly. See [ADR-008](./adr/ADR-008-production-schema-reconciliation-strategy.md) for the full corrected record.

### 11.6 Lessons and Permanent Rules

- **Development is the source of truth.** Production must always be brought to match Development — never the reverse.
- **Migration history alone cannot be trusted.** `supabase_migrations.schema_migrations` records that a migration ran; it does not prove the resulting schema is correct or complete. A direct, read-only forensic schema comparison between Development and Production is now part of every release, not an occasional audit.
- **Bootstrap and disaster-recovery claims require executable evidence.** Documentation about schema or migration-chain behavior must cite the clean migration-chain CI job that proves it; migration history and narrative accounts are not sufficient evidence.
- **Reconciliation migrations must always be additive.** No `DROP`, no destructive `UPDATE`/`DELETE`. Every statement in 013 and 014 is a column/table/function/index/policy addition or an idempotent replace.
- **Old migrations must never be rewritten after deployment.** Migration 012's undeclared dependency was fixed by adding migration 014, not by editing 012 — even though 012 had never successfully run on Production at the time the defect was found.
- **`supabase migration repair` must never be used as a shortcut.** It marks a version applied without running its SQL. It is only appropriate after the target schema has already been independently verified — by direct introspection — to match what that migration would have produced, never as a way to make a failing `db push` "succeed."

### 11.7 Post-Deployment Verification

A second forensic audit, run immediately after deployment, confirmed Development and Production are structurally identical: same 14 migrations recorded in `schema_migrations` on both, same tables, columns, constraints, indexes, functions, triggers, RLS state, and policies — with the sole exception of `public.pantry_items` (Section 9), which is expected and intentional.

**See also:** [docs/architecture.md § 19.6](./architecture.md#196-production-schema-reconciliation-july-2026), [docs/release-notes.md](./release-notes.md), [ADR-008](./adr/ADR-008-production-schema-reconciliation-strategy.md).
