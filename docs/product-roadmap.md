# ShelfLife Product Roadmap

**Classification:** Internal Engineering Reference  
**Version:** 2.0  
**Status:** Current  
**Last Updated:** July 2026  
**Live URL:** https://myshelflife.co.uk

---

> **Evidence standard:** All items in the Completed and Current sections are backed by repository evidence — committed source code, migrations, or documented architecture. Items in the Next, Future, and Long-Term sections are clearly marked as `[Planned]` or `[Concept]`. No planned work is presented as existing functionality.

---

## Table of Contents

1. [Completed — v1.0 (PantryPal)](#1-completed--v10-pantrypal)
2. [Completed — v1.5 (ShelfLife Rebrand + Community Intelligence V1)](#2-completed--v15-shelflife-rebrand--community-intelligence-v1)
3. [Completed — v2.0 (Food Knowledge Graph + Quantity-Based Shopping)](#3-completed--v20-food-knowledge-graph--quantity-based-shopping)
4. [Current State — v2.0](#4-current-state--v20)
5. [Next — v2.1](#5-next--v21)
6. [Future — v3.0](#6-future--v30)
7. [Long-Term Vision](#7-long-term-vision)
8. [Commercial Roadmap](#8-commercial-roadmap)

---

## Status Legend

| Badge | Meaning |
|---|---|
| ✅ Implemented | Feature is live in the codebase |
| 🔄 In Progress | Work has started but is not yet complete |
| 📋 Planned | Architecturally designed; not yet implemented |
| 💡 Concept | Idea under consideration; no implementation design |

---

## 1. Completed — v1.0 (PantryPal)

*Original application built session of 11–12 July 2026. Full record in [docs/development-log.md](./development-log.md).*

### Authentication Foundation ✅ Implemented

- ✅ Email/password registration with live validation, password strength, confirm field
- ✅ Login with show/hide toggle
- ✅ Supabase Auth + `@supabase/ssr` cookie-based sessions
- ✅ Middleware route protection (`/dashboard`, `/pantry`, `/meals`, `/settings`, etc.)
- ✅ Email verification via `/auth/callback` route
- ✅ Forgot password / reset password flow
- ✅ Auth redirect with `emailRedirectTo` using `getSiteUrl()`

### Pantry Management ✅ Implemented

- ✅ Add, edit, delete pantry ingredients
- ✅ Quantity, unit, expiry date fields
- ✅ Row-level security: users see only their own items
- ✅ Alphabetical list with empty state

### Receipt Scanner ✅ Implemented

- ✅ Drag-and-drop image upload to `/receipt-scanner`
- ✅ Gemini Vision API integration: image → ingredient extraction
- ✅ User review screen before committing to pantry
- ✅ Exponential retry for 502/503/504 errors
- ✅ Configurable AI model via `GEMINI_MODEL` environment variable

### Meal Suggestions ✅ Implemented

- ✅ AI-generated meal suggestions from pantry contents (Google Gemini)
- ✅ "Can Cook Now", "Nearly There", "Shopping Trip" sections
- ✅ "Cook Tonight" deducts used ingredients from pantry
- ✅ Save meals to `meals_saved` table

### Deterministic Shopping List ✅ Implemented

- ✅ Shopping list computed from `plan ingredients − pantry` (no AI)
- ✅ Category grouping, checkboxes, print/PDF export
- ✅ Auto-regeneration on pantry and planner changes

### Meal Planner ✅ Implemented

- ✅ AI-generated 3-, 5-, or 7-day meal plans
- ✅ Drag-reorder (sort_order only — day_index is immutable)
- ✅ Replace individual planned meals via AI
- ✅ Shopping list regeneration triggered by planner changes

### Recipe Catalogue ✅ Implemented

- ✅ 100 built-in recipes (`src/data/recipes.ts`)
- ✅ Pantry match percentage per recipe
- ✅ Fuzzy ingredient matching (`src/lib/ingredient-match.ts`)
- ✅ Recipe saving, search, and filtering

### Dashboard ✅ Implemented

- ✅ Dashboard home with live pantry stats, expiry warnings, quick actions
- ✅ Recipe recommendation based on current pantry

### Settings and Account Management ✅ Implemented

- ✅ Profile (display name), email update, password change
- ✅ Delete account (cascading via `delete_user_account()` RPC)
- ✅ Security info card (verified status, last sign-in)

### Design System ✅ Implemented

- ✅ CSS design tokens (`src/styles/tokens.css`)
- ✅ Tailwind v4 `@theme` integration
- ✅ Shared UI primitives: Button, Card, Input, Badge, EmptyState, Skeleton, SearchBar, etc.
- ✅ Design system components: PageHeader, SectionHeader, Typography set, ContentSection, ResponsiveGrid

---

## 2. Completed — v1.5 (ShelfLife Rebrand + Community Intelligence V1)

*Implemented on the `develop` branch. Full record in [docs/release-notes.md](./release-notes.md).*

### Application Rebrand ✅ Implemented

- ✅ All user-facing text changed from "PantryPal" to "ShelfLife"
- ✅ `package.json` name updated to `shelflife`
- ✅ `manifest.webmanifest` updated with ShelfLife branding
- ✅ OG and Twitter metadata updated
- ✅ Live URL: https://myshelflife.co.uk

### Community Food Intelligence V1 ✅ Implemented

- ✅ `platform_roles` table and `is_super_admin()` RPC for admin access control
- ✅ `community_foods` table for canonical food records (name, aliases, categories)
- ✅ `community_food_votes` table for community classification voting
- ✅ `community_food_aliases` for alias resolution
- ✅ `community_food_moderation_history` for audit trail
- ✅ `record_community_food_observation()` RPC for anonymous learning
- ✅ `get_community_food_classification()` RPC
- ✅ Platform Admin dashboard at `/platform` (SUPER_ADMIN only)
- ✅ Middleware enforcement: non-admin redirected from `/platform` to `/dashboard`
- ✅ Community intelligence server action module (`src/app/actions/community-intelligence.ts`)
- ✅ Migration chain repaired and validated against clean PostgreSQL via Docker

---

## 3. Completed — v2.0 (Food Knowledge Graph + Quantity-Based Shopping)

*Implemented on the `develop` branch. Full record in [docs/release-notes.md](./release-notes.md) and [docs/architecture.md](./architecture.md).*

### Food Knowledge Graph ✅ Implemented

- ✅ Controlled food taxonomy: `food_categories`, `food_subcategories` tables with seed data
- ✅ 17 canonical food categories (Dairy, Fruit, Vegetables, Meat, Seafood, etc.)
- ✅ User-owned `storage_locations` lookup table
- ✅ Community classification upgraded to ID-based references (migration 006)
- ✅ `classification_version` monotonic counter — stale pantry caches auto-detected
- ✅ Pantry extended with `storage_location_id`, `canonical_food_id`, `cached_category_id`, `cached_subcategory_id`, `classification_version`, `classification_updated_at`
- ✅ `substitutable` flag on `food_subcategories` for semantic ingredient families
- ✅ `resolve_community_foods` batch RPC for Knowledge Graph resolution
- ✅ Seed data for substitutable families: Pasta, Cheese

### Semantic Matching Engine ✅ Implemented

- ✅ `foodsMatch()` function with three-tier matching: canonical ID → substitutable subcategory → normalised string
- ✅ `FoodResolver` type — serializable projection of the Knowledge Graph passed to client components
- ✅ `buildFoodResolver()` server-only utility to construct a resolver from ingredient names
- ✅ Semantic matching integrated into recipe matching, recipe ranking, shopping computation, Add Missing, dashboard
- ✅ Unknown foods fall back to normalised string comparison — never silently discarded

### Pantry Stacking ✅ Implemented

- ✅ `insertOrStackPantryItem()` — merges pantry rows on (canonical_food_id + expiry_date + storage_location_id)
- ✅ Used by `addIngredient` and `saveScannedIngredients` server actions

### Receipt Review UX Unification ✅ Implemented

- ✅ Shared `IngredientFields` component used by both `AddIngredientForm` and `ReceiptIngredientReview`
- ✅ Receipt review now supports storage location selection, community classification display, suggested storage

### Pantry View Differentiation ✅ Implemented

- ✅ Comfortable view: larger cards, more metadata, confidence badges, icons
- ✅ Compact view: dense list, minimal spacing, high information density
- ✅ Structurally distinct rendering in `PantryBrowser`

### Quantity-Based Shopping ✅ Implemented

- ✅ Shopping list = Total Demand − Pantry Supply (per-ingredient quantities)
- ✅ `computeShoppingList()` aggregates across all planned meals with semantic grouping
- ✅ `demand_quantity`, `demand_unit`, `pantry_quantity`, `pantry_unit`, `used_by_meals` columns on `shopping_list_items`
- ✅ Shopping list items expandable (Need/Have/Buy + used-by meals)
- ✅ "Clear Shopping List" action with confirmation
- ✅ `needed_for_meals`, `shortage_label`, `source` persisted to DB (migration 009)
- ✅ Shared `insertShoppingListRows()` used by both `regenerateShoppingList` and `addMissingIngredientsToShoppingList`
- ✅ Quantity-aware "Add Missing Ingredients" — recipe `typical_quantities` now passed to shopping action
- ✅ `quantityAwareMissingIngredients()` helper used by RecipeCatalog and RecipeDetailModal
- ✅ "xN" quantity format support in `parseIngredientRequirement()`

### Cooking Completion Engine ✅ Implemented

- ✅ `CookingConfirmationModal` — per-ingredient quantity adjustment before pantry deduction
- ✅ `completeCookedMeal()` server action — canonical cooking completion
- ✅ `planCookedMealConsumption()` — canonical pantry consumption with per-ingredient deduction (persisted atomically via the `complete_cooked_meal` RPC, ADR-009)
- ✅ `cooking_behavior_observations` table — anonymous cooking learning (recipe vs actual usage)
- ✅ `cookMeal()` is now a compatibility wrapper for `completeCookedMeal()`
- ✅ Shopping list recalculated immediately after cooking completion

### Consolidation Work ✅ Implemented

- ✅ Canonical "Add Missing Ingredients" via `planMissingIngredientsForShoppingList()` (`.mjs`)
- ✅ `getShoppingList()` is read-only — no computation on page load
- ✅ `MissingIngredientsSection` is the single UI entry point for "Add Missing"
- ✅ All "Add Missing" callers (Planner, Recipe Detail, Recipe Catalog, Saved Meals, Meal Suggestions) use `MissingIngredientsSection`
- ✅ 17+ regression tests in `tests/recipe-shopping-list.test.mjs`

### Platform Administration ✅ Implemented

- ✅ Community Intelligence Dashboard in `/platform`
- ✅ `isSuperAdmin` prop propagated to mobile bottom navigation
- ✅ `approveCommunityFood`, `editCommunityFood` restricted to SUPER_ADMIN role

---

## 4. Current State — v2.0

### Database Health: Production Schema Reconciliation ✅ Implemented

*Database-only maintenance, not a feature release — see [docs/release-notes.md § 6](./release-notes.md#6-production-schema-reconciliation) and [docs/database-schema.md § 11](./database-schema.md#11-production-schema-reconciliation-july-2026) for the full record. Not part of the "v2.1" feature milestone below.*

- ✅ A forensic, read-only audit found Production's schema had silently drifted from its own recorded migration history (10 missing tables, 15 missing functions, 16 missing columns, and more)
- ✅ Two new additive migrations (`013`, `014`) restored full structural parity between Development and Production, verified by a second forensic audit after deployment
- ✅ Development is now formally documented as the source of truth for schema; a direct schema comparison is a required step in every release that touches the database, not just a migration-history check
- 🔄 One known, intentional exception remains: `public.pantry_items`, a legacy table on Production only, unreferenced by the application, deliberately left untouched pending a separate reviewed removal migration (tracked under Known Technical Debt below)

### What is Working

| System | Status |
|---|---|
| Authentication (register, login, email verify, password reset) | ✅ Working |
| Pantry (CRUD, stacking, storage location, classification cache) | ✅ Working |
| Receipt scanner (Gemini OCR, review, community learning) | ✅ Working |
| Recipe catalogue (100 built-in, semantic matching, pantry match %) | ✅ Working |
| Meal suggestions (AI, expiry-aware ranking) | ✅ Working |
| Saved meals | ✅ Working |
| Meal planner (AI, 3/5/7-day, reorder, replace) | ✅ Working |
| Shopping list (quantity-aware demand engine, persistence) | ✅ Working |
| Add Missing Ingredients (unified, quantity-aware, semantic) | ✅ Working |
| Cooking confirmation (per-ingredient quantity adjustment) | ✅ Working |
| Community Food Intelligence (voting, classification, moderation) | ✅ Working |
| Food Knowledge Graph (canonical foods, taxonomy, substitutable families) | ✅ Working |
| Semantic matching (canonical ID, substitutable subcategory, string fallback) | ✅ Working |
| Platform Administration (SUPER_ADMIN, community moderation dashboard) | ✅ Working |
| Settings (profile, email, password, delete account) | ✅ Working |
| Mobile navigation (including SUPER_ADMIN access) | ✅ Working |
| Design system (tokens, typography, animations) | ✅ Working |
| Vercel deployment from `main` branch | ✅ Working |

### Known Technical Debt

| Item | Status |
|---|---|
| `package.json` version field still shows `0.1.0` despite v2.0 codebase | Technical debt |
| Appearance/theme toggle is a placeholder in settings | Not implemented |
| Avatar upload is a placeholder | Not implemented |
| `window.location.reload()` used in some planner paths instead of optimistic RSC refresh | Technical debt |
| Dark mode relies on `prefers-color-scheme` only; no manual toggle | Planned (v2.1) |
| Automated test coverage limited to shopping/cooking regression suite | Technical debt |
| Cooking learning data (`cooking_behavior_observations`) stored but not acted on | Planned (v2.1) |
| Personal storage location learning (user habit vs community default) not implemented | Planned (v2.1) |
| HEIC image support depends on browser/OS native decoding | Technical debt |
| `public.pantry_items` legacy table exists on Production only (unreferenced by the app) | Technical debt — requires a separate, explicitly reviewed removal migration |
| Migration `012_reconcile_production_schema.sql` requires its FK-referenced tables to exist at execution time; this is a drifted-history limitation, not a clean-replay failure (`supabase db reset` 001→014 succeeds and is verified by CI) | Technical debt — see [ADR-008](./adr/ADR-008-production-schema-reconciliation-strategy.md) |
| **FUP-2:** `mergeCommunityFoods` alias consolidation and vote reassignment still use separate PostgREST writes, with partial-commit risk | Deferred-tracked (Phase 2) — implement a full-transaction `merge_community_foods` RPC; see [ADR-009 Deferred Follow-ups](./adr/ADR-009-transactional-write-patterns.md#deferred-follow-ups-phase-2) |
| **BUG-10:** Per-user AI rate-limiting and usage metering | **Done** — [ADR-010](./adr/ADR-010-ai-rate-limiting-usage-metering.md) accepted and shipped via migration 016; live on Development and Production since September 2026 |
| **Error-contract consistency sweep:** taxonomy CRUD, `saveMeal`, `toggle*`/`clear*`, and `addIngredient` can still expose inconsistent or raw backend errors | Deferred-tracked (Phase 2) — information-disclosure/UX risk with no data-integrity impact; apply [ADR-009 Rules #5](./adr/ADR-009-transactional-write-patterns.md#rules) |
| **RT-GAP:** RLS cross-user denial matrix, prompt-injection probe, FUP-2 partial-commit, BUG-05 conservation, and ADR-010 quota-exceeded behavior remain runtime-unverified | Verification debt — pending a capable test environment with a working shell, A/B/super-admin JWTs, and Gemini fault harness. Design and schema assurance are strong, but runtime closure remains open |
| **F-2b:** AI free text enters prompts without explicit prompt-injection neutralization beyond JSON mode and response parse validation | Deferred-tracked security review — define mitigation and run a runtime prompt-injection probe |
| **F-2a:** `withGeminiRetry()` retries 502/503/504, not provider 429 responses | Deferred-tracked low-resilience improvement — ADR-010 quota enforcement is the primary remedy; optional provider `Retry-After`/backoff support may be added later |

---

## 5. Next — v2.1

*The items below are planned based on the current architecture and known gaps. None are currently implemented.*

### Theme Toggle 📋 Planned

- Manual light/dark mode toggle in Settings → Appearance
- Design tokens already anticipate this via semantic colour variables in `tokens.css`

### Cooking Behaviour Learning 📋 Planned

- Use data in `cooking_behavior_observations` to personalise future recipe suggestions
- Surface patterns: "You usually double garlic" / "You never use mushrooms"
- Store preferences per user without modifying community recipes or community data

### Personal Storage Suggestions 📋 Planned

- Layer personal storage habits on top of community suggestions
- Example: community suggests Butter → Fridge; user consistently moves it to Freezer → app learns to suggest Freezer for this user
- Architecture: extend storage suggestion logic in `src/lib/storage-locations.ts` with user history

### Pantry Classification Prompting 📋 Planned

- When `confidence_score < 40` (Unclassified tier), prompt the user to classify the food
- Once confidence reaches the Community threshold, never prompt future users
- UI already anticipates confidence tiers via `src/lib/food-classification.ts`

### Receipt Scanner Improvements 📋 Planned

- Improved HEIC support
- Batch review with bulk confirm
- Better quantity parsing for supermarket receipt formats
- Community learning for receipt ingredient names (alias resolution)

### Notifications 📋 Planned

- Expiry alerts (items expiring within N days)
- Shopping list reminders
- Meal plan reminders

### Analytics (Internal) 📋 Planned

- Admin dashboard for community food statistics
- Classification confidence trends
- Most common foods across the community (anonymous)
- Shopping pattern insights (anonymous)

### Shopping Optimisation 📋 Planned

- Manual item additions persist across shopping list regenerations
- Shopping list "locked items" that regeneration does not overwrite

---

## 6. Future — v3.0

*The items below are conceptual. No implementation design exists for these features.*

### Household Sharing 💡 Concept

- Multiple users sharing one pantry (household)
- Requires significant RLS redesign: `household_id` replacing or supplementing `user_id`
- Conflict resolution for simultaneous edits
- Invite workflow

### Family Planning 💡 Concept

- Dietary preference profiles per household member
- Meal planning that accommodates different preferences
- Per-person portion tracking

### Barcode Scanning 💡 Concept

- Camera-based barcode scan on mobile
- Product database lookup (Open Food Facts or similar)
- Auto-populate ingredient name, category, typical storage

### Predictive Purchasing 💡 Concept

- Forecast when pantry items will run out based on consumption history
- Suggest reorder before stock runs out
- Requires consumption history (foundations in `cooking_behavior_observations`)

### AI Pantry Assistant 💡 Concept

- Conversational interface: "What can I cook with what I have this week?"
- Natural language pantry queries
- Recipe suggestions beyond the current catalogue

### Voice Assistant Integration 💡 Concept

- "Add 2 litres of milk to my pantry"
- Hands-free pantry updates during grocery unpacking

### Offline Mode 💡 Concept

- PWA with service worker caching for shopping list and pantry browse
- Background sync when connectivity is restored
- `manifest.webmanifest` already exists; full PWA service worker not implemented

### Mobile Application 💡 Concept

- Native iOS and Android applications
- Deep integration with camera for receipts and barcodes
- Push notifications for expiry alerts

### Gamification 💡 Concept

- Waste reduction score
- Meal planning streaks
- Community badges for food classification contributions

---

## 7. Long-Term Vision

ShelfLife's long-term vision, as reflected in the current architecture, is to build a **continuously improving food knowledge platform** where:

1. Every user who classifies a food makes the platform smarter for every future user
2. Every receipt scan improves alias recognition
3. Every cooked meal improves portion understanding
4. The Knowledge Graph becomes a competitive asset that grows automatically with usage

The architectural decisions supporting this vision are documented in:
- [docs/adr/ADR-004-community-food-intelligence.md](./adr/ADR-004-community-food-intelligence.md)
- [docs/adr/ADR-007-canonical-food-knowledge-graph.md](./adr/ADR-007-canonical-food-knowledge-graph.md)
- [docs/adr/ADR-005-semantic-matching.md](./adr/ADR-005-semantic-matching.md)

---

## 8. Commercial Roadmap

*The items below are conceptual commercial directions. No implementation design exists.*

### Subscription Tiers 💡 Concept

- **Free tier:** Core pantry, basic recipe catalogue, basic meal planning
- **Premium tier:** AI features (receipt scanning, AI meal suggestions, AI planner), advanced analytics, cooking behaviour personalisation
- **Household tier:** Multi-user household sharing, family planning

### Enterprise / B2B 💡 Concept

- White-label platform for food retailers
- Integration with supermarket loyalty programs
- API for third-party food apps to consume the Knowledge Graph

### API 💡 Concept

- Public REST API for the Food Knowledge Graph
- Third-party integrations: recipe apps, smart appliances, food delivery platforms
- Developer documentation and SDKs

### Integrations 💡 Concept

- Supermarket APIs (click-and-collect, grocery delivery)
- Smart home integrations (Alexa, Google Home)
- Nutrition tracking platforms
- Food delivery services
