# ShelfLife Developer Onboarding Guide

**Classification:** Internal Engineering Reference  
**Version:** 2.0  
**Status:** Current  
**Audience:** New engineers, onboarding developers, AI coding assistants  
**Last Updated:** July 2026  
**Repository:** https://github.com/nathanbrendish/shelflife  
**Live URL:** https://myshelflife.co.uk

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [Technology Stack](#3-technology-stack)
4. [Prerequisites](#4-prerequisites)
5. [Local Setup](#5-local-setup)
6. [Environment Variables](#6-environment-variables)
7. [Supabase Setup](#7-supabase-setup)
8. [Running the Application](#8-running-the-application)
9. [Running Tests](#9-running-tests)
10. [Lint and Build](#10-lint-and-build)
11. [Database Migrations](#11-database-migrations)
12. [Branch and Git Workflow](#12-branch-and-git-workflow)
13. [Development Workflow](#13-development-workflow)
14. [Deployment](#14-deployment)
15. [Debugging](#15-debugging)
16. [Common Issues and Troubleshooting](#16-common-issues-and-troubleshooting)
17. [Documentation Index](#17-documentation-index)
18. [Best Practices](#18-best-practices)
19. [Common Mistakes to Avoid](#19-common-mistakes-to-avoid)

---

## 1. Project Overview

ShelfLife is an AI-powered pantry management, meal planning, and shopping list application. Users scan receipts, manage expiry, plan meals using AI, and generate deterministic shopping lists.

**Core product loop:**
```
Receipt scan → Pantry → Recipe matching → Meal planning → Shopping list → Cook → Pantry updated
```

**Key engineering principles:**
- AI generates meals; mathematics generates shopping lists
- Community Food Intelligence is the single source of truth for food classification
- The pantry caches classification data; it never owns it
- Shared components handle common behaviour — never duplicate logic
- Server Actions handle all mutations; REST API is used only for binary AI routes

**Full technical context:** See [docs/architecture.md](./architecture.md)

---

## 2. Repository Structure

```
shelflife/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── actions/                  # Server Actions (mutations)
│   │   │   ├── auth.ts
│   │   │   ├── pantry.ts
│   │   │   ├── meals.ts
│   │   │   ├── planner.ts
│   │   │   ├── shopping.ts
│   │   │   ├── shopping-list.ts
│   │   │   ├── receipt.ts
│   │   │   ├── dashboard.ts
│   │   │   ├── settings.ts
│   │   │   └── community-intelligence.ts
│   │   ├── api/
│   │   │   └── scan-receipt/route.ts # POST – Gemini Vision OCR
│   │   ├── auth/callback/route.ts    # Supabase auth code exchange
│   │   ├── dashboard/page.tsx
│   │   ├── pantry/page.tsx
│   │   ├── receipt-scanner/page.tsx
│   │   ├── meals/page.tsx
│   │   ├── recipes/page.tsx
│   │   ├── saved-meals/page.tsx
│   │   ├── planner/page.tsx
│   │   ├── shopping/page.tsx
│   │   ├── settings/page.tsx
│   │   ├── platform/page.tsx         # SUPER_ADMIN only
│   │   ├── login/page.tsx
│   │   ├── register/page.tsx
│   │   ├── forgot-password/page.tsx
│   │   └── reset-password/page.tsx
│   ├── components/                   # React UI components
│   │   ├── platform/                 # Platform admin components
│   │   ├── ui/                       # Design-system primitives
│   │   ├── ds/                       # Typography, layout, barrel
│   │   └── *.tsx                     # Feature components
│   ├── data/
│   │   └── recipes.ts                # 100 built-in recipes
│   ├── lib/                          # Pure logic, SDK wrappers
│   │   ├── gemini/                   # AI config, prompts, parsers, retry
│   │   ├── supabase/                 # client.ts, server.ts, middleware.ts
│   │   └── *.ts / *.mjs              # Domain utilities
│   ├── middleware.ts                 # Session refresh + route guards
│   ├── styles/                       # tokens.css, theme.css, base.css
│   └── types/                        # TypeScript type definitions
├── supabase/
│   └── migrations/                   # 001–014 SQL migrations
├── tests/
│   └── recipe-shopping-list.test.mjs # Node test runner regression tests
├── scripts/
│   ├── generate-recipes.mjs
│   └── add-recipe-instructions.mjs
├── docs/                             # Engineering documentation
│   └── adr/                          # Architecture Decision Records
├── public/                           # Static assets
├── .env.local                        # Local secrets (not committed)
├── package.json
├── tsconfig.json
├── next.config.ts
└── eslint.config.mjs
```

---

## 3. Technology Stack

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Framework | Next.js | 16.2.10 | App Router, Server Components, Server Actions |
| UI | React | 19.2.4 | Component model |
| Language | TypeScript | 5.x | Type safety (strict mode) |
| Styling | Tailwind CSS | 4.x | Utility-first CSS with design tokens |
| Database | Supabase (PostgreSQL) | Latest | Auth, database, RLS, RPC functions |
| Auth | Supabase Auth + `@supabase/ssr` | 0.12.0 | Session management, cookie-based SSR |
| AI | Google Gemini (`@google/generative-ai`) | 0.24.1 | Receipt OCR, meal suggestions, meal planning |
| Icons | Lucide React | 1.24.0 | Icon set |
| Testing | Node.js built-in test runner | — | `node --test` |
| Deployment | Vercel | — | Production hosting, preview deployments |
| CSS processing | `@tailwindcss/postcss` | 4.x | PostCSS integration |
| Linting | ESLint 9 + `eslint-config-next` | — | Code quality |

For the rationale behind these choices, see [docs/adr/](./adr/).

---

## 4. Prerequisites

### Required Software

| Tool | Minimum Version | Notes |
|---|---|---|
| Node.js | 18.18.0+ | Required by Next.js 16. Use nvm or fnm to manage versions |
| npm | 9.x+ | Comes with Node.js |
| Git | 2.x+ | |
| Supabase CLI | Latest | For migration management |

### Recommended Tools

- [VS Code](https://code.visualstudio.com/) or [Cursor](https://cursor.sh/)
- VS Code extensions: ESLint, Tailwind CSS IntelliSense, Prisma (for SQL syntax)
- [Supabase Studio](https://supabase.com/dashboard) — web UI for database inspection
- [Postman](https://www.postman.com/) or similar — for testing the `/api/scan-receipt` route

### Checking Your Environment

```bash
node --version     # Should be >= 18.18.0
npm --version      # Should be >= 9.0.0
git --version
npx supabase --version
```

---

## 5. Local Setup

### 1. Clone the repository

```bash
git clone https://github.com/nathanbrendish/shelflife.git
cd shelflife
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create your local environment file

```bash
cp .env.local.example .env.local   # If template exists
# Or create it manually — see Section 6
```

### 4. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## 6. Environment Variables

Create a `.env.local` file in the project root. **This file must never be committed.**

```bash
# .env.local

# Supabase — Development project
NEXT_PUBLIC_SUPABASE_URL=https://<your-dev-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-dev-anon-key>

# Google Gemini AI
GEMINI_API_KEY=<your-gemini-api-key>

# Optional: override the default model (gemini-3.5-flash)
# GEMINI_MODEL=gemini-3.5-flash

# Site URL — required for auth redirects (email confirmation, password reset)
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

### Variable Reference

| Variable | Where Used | Required | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Client + server | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client + server | Yes | RLS-scoped anon key. Public but limited by RLS |
| `GEMINI_API_KEY` | Server only | Yes | Powers receipt OCR, meal suggestions, meal planning |
| `GEMINI_MODEL` | Server only | No | Overrides default `gemini-3.5-flash` |
| `NEXT_PUBLIC_SITE_URL` | Server + auth | Yes | Canonical origin. Used in `emailRedirectTo` for auth emails |

### Supabase Project Environments

There are two Supabase projects:

| Environment | Purpose | Used When |
|---|---|---|
| **Development** | Feature development, testing, migrations | `npm run dev`, PR previews |
| **Production** | Live traffic at myshelflife.co.uk | `main` branch Vercel deployment |

> **Never connect your local environment to the Production Supabase project.** Always use the Development project for local development and migration testing.

> **Development is the source of truth for schema.** Production must always be brought to structural parity with Development, never the reverse. Do not assume the two are in sync just because `supabase migration list` reports the same versions on both — see [Section 11.4](#114-comparing-development-and-production-schema-audits) for why migration history alone is not sufficient evidence.

---

## 7. Supabase Setup

### Install the Supabase CLI

```bash
# macOS / Linux (Homebrew)
brew install supabase/tap/supabase

# Windows (Scoop)
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase

# npm (cross-platform)
npm install -g supabase
```

### Link Your Project

```bash
# Login
supabase login

# Link to the development project
# Find your project ref in the Supabase dashboard URL: supabase.com/dashboard/project/<ref>
supabase link --project-ref <development-project-ref>
```

### Apply Migrations

```bash
# Apply all pending migrations to the linked project
supabase db push
```

### Inspect Migration Status

```bash
supabase migration list
```

### Creating a New Migration

```bash
# Preferred: create an empty file with the correct naming convention
# Naming: NNN_descriptive_snake_case_name.sql
# Example (the next available number as of migration 015):
touch supabase/migrations/016_add_user_preferences.sql
```

See [Migration naming conventions](#migration-naming-conventions) below.

### Resetting the Database (Development Only)

```bash
# WARNING: Destroys all data. Development only.
supabase db reset
```

The repository now includes `supabase/config.toml` and a deterministic `supabase/seed.sql`, so `supabase db reset` replays the full migration chain (001→latest) and seeds a fresh local database. This is the same clean replay the CI `migrations` job runs on every PR.

---

## 8. Running the Application

### Development Server

```bash
npm run dev
```

Uses Next.js development mode with Turbopack. Hot reload is active.

### Production Build

```bash
npm run build
npm start
```

### Verify Environment Variables Loaded

If you suspect environment variable issues in development, add a temporary log (then remove it) in a server action, or check the Vercel runtime logs for preview deployments. See [docs/development-log.md](./development-log.md) for the history of environment variable debugging.

---

## 9. Running Tests

```bash
npm test
```

This runs `node --test tests/*.test.mjs`. The unit suite is in `tests/recipe-shopping-list.test.mjs` and uses Node.js's built-in test runner (no external test framework required). It is dependency-free and does not require a database.

### Integration (fault-injection) tests

```bash
supabase db reset            # clean replay of migrations 001 -> latest
npm run test:fault-injection # node --test tests-integration/*.test.mjs
```

`tests-integration/fault-injection.test.mjs` runs against a live local Supabase Postgres and proves each ADR-009 transactional RPC is atomic (it forces a later write to fail and asserts the whole transaction rolled back). It is deliberately excluded from `npm test` and is run by the CI `migrations` job immediately after a clean `supabase db reset`. Requires `SUPABASE_DB_URL` (see `.github/workflows/ci.yml`).

### What the tests cover

- `addMissingIngredientsToShoppingList` does not call `regenerateShoppingList`
- `getShoppingList` is read-only (no planner imports)
- Multiple missing ingredients are all inserted
- Semantic matching: covered ingredients are skipped
- Semantic non-match: missing ingredients are inserted
- Unknown ingredients (not in Knowledge Graph) fall back to display name
- Duplicate protection: repeated invocations do not create duplicates
- All UI entry points use `MissingIngredientsSection` → `AddMissingToShoppingButton`
- Shopping UI renders every category emitted by `categorizeIngredient()`
- Shopping demand engine aggregates quantities and subtracts pantry supply
- Shopping insertions use the shared `insertShoppingListRows()` path
- Cooking completion uses the canonical pantry consumption engine
- Cooking confirmation supports used / modified / skipped / extra usage

### Running a single test file manually

```bash
node --test tests/recipe-shopping-list.test.mjs
```

---

## 10. Lint and Build

### Lint

```bash
npm run lint
```

Uses ESLint 9 with `eslint-config-next`. Zero lint errors is a hard requirement before merging.

### Type Check

The Next.js build performs a full TypeScript type check. Run it explicitly with:

```bash
npm run build
```

### Build

```bash
npm run build
```

A green build (`exit code 0`) is required before any merge or deployment. Never disable TypeScript errors with `@ts-ignore` without documenting the reason.

---

## 11. Database Migrations

### Migration Naming Convention

```
NNN_descriptive_snake_case_name.sql
```

| Part | Rule | Example |
|---|---|---|
| `NNN` | 3-digit zero-padded sequence | `012`, `013` |
| `_` | Separator | — |
| `descriptive_name` | Snake case, describes the change | `add_user_preferences` |

**Examples:**
```
001_pantry_items.sql
002_v2_features.sql
011_cooking_behavior_observations.sql
014_defensive_pantry_prerequisite_guard.sql
015_add_user_preferences.sql    ← next migration
```

### Migration Rules

- **Never edit a migration that has already been applied** to any environment — even to fix a defect discovered later. Fix forward with a new migration.
- All changes must be **additive** — new migrations only
- Use `ADD COLUMN IF NOT EXISTS` to prevent replay errors
- Use `CREATE TABLE IF NOT EXISTS` for new tables
- Include a comment block at the top explaining the migration's purpose
- Test every migration in a local Docker environment or against the development project before pushing
- Never use `supabase migration repair` to make a failing `db push` succeed. See [11.6](#116-what-never-to-do) below.

### Current Migration Chain

| # | File | Key Changes |
|---|---|---|
| 001 | `001_pantry_items.sql` | Creates `pantry` table |
| 002 | `002_v2_features.sql` | Adds qty/expiry to pantry; creates meals_saved, meal_plans, meal_plan_items, shopping_list_items |
| 003 | `003_delete_account.sql` | `delete_user_account()` RPC |
| 004 | `004_community_food_intelligence.sql` | Platform roles, Community Foods, aliases, votes, moderation history |
| 005 | `005_food_taxonomy.sql` | food_categories, food_subcategories, storage_locations (with seed data) |
| 006 | `006_community_classification.sql` | ID-based classification, classification_version trigger |
| 007 | `007_pantry_storage_and_cache.sql` | Pantry storage_location_id and classification cache columns |
| 008 | `008_semantic_matching.sql` | substitutable flag, batch resolve RPC, seed pasta/cheese families |
| 009 | `009_shopping_list_metadata.sql` | needed_for_meals, shortage_label, source on shopping_list_items |
| 010 | `010_shopping_demand_details.sql` | demand_quantity, pantry_quantity, used_by_meals on shopping_list_items |
| 011 | `011_cooking_behavior_observations.sql` | cooking_behavior_observations table |
| 012 | `012_reconcile_production_schema.sql` | Reconciles `pantry`'s migration 004/007 columns on Production. Has an undeclared dependency on tables created by 013 — see 11.3 below |
| 013 | `013_reconcile_production_to_development.sql` | Comprehensive additive reconciliation of all Dev↔Prod schema drift found by forensic audit (10 tables, 16 columns, 15 functions, 1 trigger, 13 indexes). Verified no-op on Development |
| 014 | `014_defensive_pantry_prerequisite_guard.sql` | Forward-only hardening of 012's FK prerequisite dependency. Does not edit 012 |

For full column-by-column schema, see [docs/database-schema.md](./database-schema.md), and for the full incident record behind migrations 012–014, see [docs/database-schema.md § 11](./database-schema.md#11-production-schema-reconciliation-july-2026).

### 11.3 How Migrations Are Written and Validated

1. Search the repository (`rg` against `src/` and `supabase/migrations/`) to confirm no existing migration or table already covers the change.
2. Write the migration using only additive, idempotent statements (`IF NOT EXISTS`, `CREATE OR REPLACE`, guarded `DO $$ ... $$` blocks for constraints and policies that lack native `IF NOT EXISTS` support).
3. Apply it to the Development Supabase project with `supabase db push` and confirm the intended objects now exist.
4. Re-run `supabase db push` a second time against Development and confirm every statement reports "already exists, skipping" (or the equivalent) — this is your own proof that the migration is idempotent before it ever reaches Production.
5. Update `docs/database-schema.md` with the new/changed objects.
6. Only after Development validation is clean does the same migration get applied to Production.

### 11.4 Comparing Development and Production: Schema Audits

**Do not rely on `supabase migration list` alone.** It reports which migration *versions* are recorded as applied — it does not verify that every statement in each of those migrations actually ran, or that the resulting objects still exist and are correctly shaped. The July 2026 Production Schema Reconciliation (see [docs/database-schema.md § 11](./database-schema.md#11-production-schema-reconciliation-july-2026)) happened precisely because Production's recorded history and its actual schema had silently diverged.

To perform a real schema audit:

1. If Docker is available, `supabase db dump --schema public` against each project gives a full `pg_dump`-based schema snapshot for diffing. This is the preferred method when available.
2. If Docker is not available, use `supabase db query` (a plain, read-only SQL execution against the linked project) with catalog queries against `information_schema.tables`, `information_schema.columns`, `pg_indexes`, `pg_constraint`, `pg_policies`, and `pg_proc` (via `to_regprocedure()` / `pg_get_functiondef()`) to enumerate every table, column, constraint, index, function, trigger, and policy.
3. Run the same query against both Development and Production, normalise the output (e.g. sort rows, pretty-print JSON), and diff the two result sets.
4. Any difference that is not an explicitly documented, intentional exception (currently: `public.pantry_items`, Production-only) is drift that needs a reconciliation migration.

This audit is **read-only** — it must never execute DDL or DML against Production as part of the comparison itself.

### 11.5 How to Safely Deploy Migrations

1. Apply and validate against Development first (see 11.3).
2. Run the full application test/lint/build gate (`npm test && npm run lint && npm run build`).
3. Apply to Production via `supabase link --project-ref <production-ref>` then `supabase db push`.
4. Run a forensic schema audit (11.4) against Production immediately after, and compare it to the same audit against Development.
5. If the audit finds only the known, documented exceptions, the deployment is complete. If it finds anything else, do not proceed to release — investigate before merging to `main` or deploying to Vercel.
6. Switch back to the Development project ref for local work: `supabase link --project-ref <development-ref>`.

### 11.6 What Never to Do

- **Never edit a historical migration**, even one that is later discovered to be incomplete or defective (as `012_reconcile_production_schema.sql` was). Add a new migration instead (see how `014_defensive_pantry_prerequisite_guard.sql` handles this).
- **Never fake migration history.** Do not manually `INSERT` or `DELETE` rows in `supabase_migrations.schema_migrations` to make the recorded state match what you believe should be true.
- **Never use `supabase migration repair`** as a substitute for actually running a migration's SQL. It is only appropriate after the target schema has already been independently verified — via direct introspection, not assumption — to already match what that migration would have produced. Using it to force a failing `db push` to "succeed" is exactly how migration history and actual schema state can silently diverge, which is what caused the July 2026 incident.
- **Never bundle a destructive change (`DROP TABLE`, `DROP COLUMN`) into an additive reconciliation migration.** Destructive changes get their own migration, with their own explicit review, after confirming via schema audit and code search that nothing depends on the object being removed.
- **Never assume Development and Production are in sync from migration history alone.** Always corroborate with a direct schema audit (11.4) before a release that could plausibly have drifted.

### Supabase Auth Email Redirect Setup

In the Supabase dashboard for any project, add these URLs under **Authentication → URL Configuration → Redirect URLs**:

```
http://localhost:3000/auth/callback
https://myshelflife.co.uk/auth/callback
https://<vercel-preview-url>/auth/callback
```

---

## 12. Branch and Git Workflow

### Branches

| Branch | Purpose | Deploys To |
|---|---|---|
| `main` | Production-ready code | Vercel production (myshelflife.co.uk) |
| `develop` | Feature integration branch | Vercel preview deployment |
| `fix/migration-chain` | Historical: migration repair work | — |
| `feature/<name>` | Individual features | Vercel preview (per branch) |

### Git Flow

```
main
  └─── develop
            └─── feature/my-feature
```

1. Branch from `develop` for features
2. Open PR against `develop`
3. `develop` → `main` PR for releases

### Commit Messages

Use clear, present-tense imperative:

```
feat: add cooking confirmation modal
fix: prevent Fresh Basil from being dropped in Add Missing
refactor: consolidate shopping insertion into shared persistence module
docs: add ADR-005 for semantic matching
test: add regression test for quantity-aware shopping rows
chore: bump package dependencies
```

Format: `<type>: <short description>`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

---

## 13. Development Workflow

### Adding a New Feature

1. **Branch** from `develop`
2. **Search** the repository for any existing implementation of similar logic before writing new code
3. **Build** on shared components where they exist (`MissingIngredientsSection`, `IngredientFields`, `insertShoppingListRows`, `insertOrStackPantryItem`, etc.)
4. **Write** server actions for mutations; use `revalidatePath` to invalidate cache
5. **Test** — run `npm test`, `npm run lint`, `npm run build` before raising a PR
6. **Document** — if the change modifies shared architecture, update the relevant doc

### Adding a New Database Table or Column

1. Create a new migration file following naming conventions
2. Use `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`
3. Add RLS policies for every new table
4. Update `docs/database-schema.md` with the new table/column
5. Update `src/types/` with new TypeScript types
6. Apply via `supabase db push`

### Adding a New Server Action

1. Add to the appropriate `src/app/actions/` file
2. Always authenticate via `getAuthenticatedUser()` at the top
3. Scope DB queries with `user_id = user.id`
4. Call `revalidatePath()` for all affected routes after mutations
5. Return typed discriminated union: `{ success: true }` or `{ success: false; error: string }`
6. Document the new action in `docs/api-reference.md`

### Modifying a Shared Component

Before modifying any shared component, utility, or server action:

1. Run `rg "<component-name>" src/` to find every caller
2. Verify the change is backward-compatible for all callers
3. Test all affected pages manually

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full shared component policy.

---

## 14. Deployment

### How Deployment Works

ShelfLife deploys on Vercel. All pushes to `main` trigger a production deployment at https://myshelflife.co.uk.

### Required Vercel Environment Variables

Set these in the Vercel dashboard for both Preview and Production environments:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
GEMINI_API_KEY
GEMINI_MODEL          (optional)
NEXT_PUBLIC_SITE_URL  (set to https://myshelflife.co.uk for production)
```

### Pre-Deployment Checklist

```
[ ] npm run build passes locally with exit code 0
[ ] npm run lint passes with zero errors
[ ] npm test passes
[ ] Migration-chain CI passes a clean `supabase db reset`; cite this job for any
    bootstrap or disaster-recovery claim (history and prose are not proof)
[ ] All new migrations applied to the target Supabase project
[ ] Forensic schema audit confirms Development and Production match (see Section 11.4) —
    not just a matching `supabase migration list`
[ ] Supabase redirect URLs updated if new auth paths added
[ ] No secrets committed to the repository
[ ] NEXT_PUBLIC_SITE_URL is set correctly for the environment
```

### Applying Migrations to Production

```bash
# Link to production project first
supabase link --project-ref <production-project-ref>

# Then push
supabase db push

# Switch back to development
supabase link --project-ref <development-project-ref>
```

> Do not run `supabase db reset` against the production project. It destroys all data.

### Release Workflow

```
Development
  ↓  (feature work, new migrations validated per Section 11.3)
Validation
  ↓  (npm test / lint / build; migration applied to and verified against Development)
Production deployment
  ↓  (migration applied to the Production Supabase project)
Forensic comparison
  ↓  (direct Dev ↔ Prod schema audit per Section 11.4 — not a migration-history check)
Release
  ↓  (merge develop → main, push to origin)
Vercel deployment
```

If the forensic comparison step surfaces any difference beyond the known, documented exceptions (currently: `public.pantry_items`, Production-only — see [docs/database-schema.md § 9](./database-schema.md#9-technical-debt)), **stop and investigate before continuing to the Release step.** Do not merge to `main` or deploy while Development and Production are structurally different for unexplained reasons.

---

## 15. Debugging

### Supabase Errors

| Error | Likely Cause |
|---|---|
| `"Invalid API key"` | Wrong `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the environment |
| `relation "..." does not exist` | Migration not applied. Run `supabase db push` |
| `Could not find the '<column>' column of '<table>' in the schema cache` | The column exists in Development but not in the environment you're querying — usually means migration history and actual schema have diverged there. Run a forensic schema audit (Section 11.4) rather than assuming the migration ran correctly |
| `Not authenticated` | `auth.uid()` is NULL in an RPC; action called without a valid session |
| `permission denied` | RLS policy missing or SECURITY DEFINER function not granted to `authenticated` role |

### Gemini Errors

| Error | Likely Cause |
|---|---|
| `"Meal suggestions are not configured."` | `GEMINI_API_KEY` not set |
| 404 on model | Model name invalid. Check `GEMINI_MODEL` env; default is `gemini-3.5-flash` |
| 503 intermittent | Transient provider overload; retry logic handles this automatically |

See `src/lib/gemini/map-gemini-error.ts` for the full error mapping.

### Shopping List Debugging

If the shopping list contains unexpected items, check:
1. Was `regenerateShoppingList()` called unintentionally? It should only be triggered by pantry/planner mutations.
2. Was `getShoppingList()` returning cached stale data? It reads `shopping_list_items` directly — no computation.
3. Are `demand_quantity` / `pantry_quantity` null? This means the ingredient arrived via `addMissingIngredientsToShoppingList` without a quantity string.

### Pantry Classification Debugging

If pantry items show "Unclassified":
1. `confidence_score < 40` — the food has too few community votes
2. `canonical_food_id` is NULL — the food was never resolved against the Knowledge Graph
3. Call `refresh_stale_pantry_classifications()` manually via Supabase SQL editor to force a cache refresh

---

## 16. Common Issues and Troubleshooting

| Issue | Symptom | Solution |
|---|---|---|
| Auth redirect fails | `/auth/callback` returns error | Check `NEXT_PUBLIC_SITE_URL` and Supabase redirect URL allow-list |
| Shopping list empty after regen | No items returned | Check meal plan exists (`meal_plans` table); check pantry not empty |
| Receipt scan fails with EMPTY_RESULT | No ingredients extracted | Image quality too low; try a clearer photo |
| Build fails with type error | `npm run build` exits non-zero | Fix TypeScript errors; never use `@ts-ignore` without documented reason |
| Migrations conflict | `relation already exists` | Use `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS` |
| Production schema doesn't match Development despite matching migration history | Runtime "column/relation does not exist" errors on Production only | Migration history is not proof of schema state — run a forensic schema audit (Section 11.4) and reconcile with a new additive migration. Never use `supabase migration repair` as a shortcut |
| SUPER_ADMIN redirect loop | `/platform` redirects immediately | User row missing in `user_roles` for `SUPER_ADMIN` role; add via Supabase dashboard |
| Gemini returns empty meal plan | No meals parsed | Retry; if persistent, check prompt in `src/lib/gemini/planner-prompt.ts` |

### Useful Commands

```bash
# Start dev server
npm run dev

# Run all tests
npm test

# Lint
npm run lint

# Build
npm run build

# Apply pending migrations
supabase db push

# Check migration status
supabase migration list

# Open Supabase SQL editor (redirects to dashboard)
supabase dashboard

# Search codebase for a symbol
rg "symbolName" src/

# Search for component usage
rg "insertShoppingListRows" src/

# Check git status
git status

# Check current branch
git branch
```

---

## 17. Documentation Index

| Document | Purpose |
|---|---|
| [README.md](../README.md) | Getting started, quick reference |
| [docs/architecture.md](./architecture.md) | Full system architecture (canonical reference) |
| [docs/api-reference.md](./api-reference.md) | Every server action and API route |
| [docs/database-schema.md](./database-schema.md) | Every table, column, constraint, RLS policy |
| [docs/release-notes.md](./release-notes.md) | Full release history |
| [docs/development-log.md](./development-log.md) | Session-by-session build log (PantryPal → ShelfLife v1) |
| [docs/developer-onboarding.md](./developer-onboarding.md) | This document |
| [docs/product-roadmap.md](./product-roadmap.md) | Strategic evolution and planned features |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Engineering standards and contribution process |
| [docs/adr/](./adr/) | Architecture Decision Records |
| [ADR-009: Transactional Write Patterns](./adr/ADR-009-transactional-write-patterns.md) | Atomic persistence rules for multi-step Server Actions |
| [docs/community-food-intelligence.md](./community-food-intelligence.md) | Community Food Intelligence deep-dive |

---

## 18. Best Practices

### Always

- Authenticate before every database operation: `const { supabase, user } = await getAuthenticatedUser()`
- Scope every query with `eq("user_id", user.id)`
- Return typed error responses — never throw to the client
- Run `npm test && npm run lint && npm run build` before pushing
- Use `revalidatePath()` after all mutations that affect page data
- Use `insertOrStackPantryItem()` for single-item pantry writes (`addIngredient`); batch receipt saves go through the `save_scanned_items` RPC (ADR-009) — never insert into `pantry` directly outside these paths
- Use `insertShoppingListRows()` for the additive "Add Missing" path; full regeneration goes through the `regenerate_shopping_list` RPC (ADR-009) — never insert into `shopping_list_items` directly outside these paths
- Any Server Action performing more than one dependent write must persist through a transactional RPC (ADR-009), not sequential Supabase calls
- Use `addMissingIngredientsToShoppingList()` via `MissingIngredientsSection` — never build custom Add Missing implementations
- Add `IF NOT EXISTS` to every migration statement
- Keep community learning non-blocking: wrap in try/catch, return empty cache on failure

### Never

- Connect local development to the Production Supabase project
- Edit a migration that has already been applied to any environment
- Fake or manually edit migration history (`supabase_migrations.schema_migrations`) to match what you believe should be true
- Use `supabase migration repair` as a shortcut to make a failing `db push` succeed, without first independently verifying via direct schema introspection that the target already matches what the migration would produce
- Assume Development and Production are in sync because `supabase migration list` shows the same versions on both — always corroborate with a direct schema audit (Section 11.4) before a release
- Duplicate "Add Missing Ingredients" logic — route everything through `addMissingIngredientsToShoppingList()`
- Duplicate pantry insertion logic — use `insertOrStackPantryItem()`
- Duplicate shopping insertion logic — use `insertShoppingListRows()`
- Generate shopping list content with AI (the shopping list is deterministic math, not AI)
- Call `regenerateShoppingList()` from a read path
- Store sensitive credentials in anything other than `.env.local` (local) or Vercel environment variables (deployed)

---

## 19. Common Mistakes to Avoid

| Mistake | Consequence | Correct Approach |
|---|---|---|
| Inserting directly into `pantry` | Bypasses stacking logic; creates duplicate rows | Always use `insertOrStackPantryItem()` |
| Inserting directly into `shopping_list_items` | Bypasses type safety and quantity fields | Always use `insertShoppingListRows()` |
| Building a custom "Add Missing" implementation | Inconsistent behaviour across pages; bugs difficult to trace | Route through `addMissingIngredientsToShoppingList()` via `MissingIngredientsSection` |
| Calling `regenerateShoppingList()` on page load | Forces full planner recomputation on every read; defeats persistence | `getShoppingList()` for reads; regen only on mutations |
| String comparison for ingredient matching | "Macaroni" does not match "Pasta"; recipe matching breaks | Use `foodsMatch()` with a `FoodResolver` built by `buildFoodResolver()` |
| Editing an applied migration | Creates chain inconsistency; `supabase db push` will fail | Create a new migration instead |
| Trusting `supabase migration list` as proof Development and Production match | Schema drift goes undetected until a runtime error surfaces it (see the July 2026 Production Schema Reconciliation) | Run a forensic schema audit (Section 11.4) before any release that touches the database |
| Using `supabase migration repair` to force a failing `db push` through | Records a migration as applied without its SQL ever running — the exact root cause of the July 2026 incident | Fix the underlying dependency or ordering issue with a new additive migration instead |
| Setting `NEXT_PUBLIC_SITE_URL` to production URL locally | Auth redirects in local testing go to production | Use `http://localhost:3000` locally |
| Forgetting `revalidatePath` after a mutation | Stale UI data; page does not refresh after action | Add `revalidatePath()` to all mutation actions |
| Using `day_index` for sort order | Planner reorder corrupts day assignments | `day_index` is immutable post-creation; use `sort_order` for ordering only |
| Hardcoding food synonym lists | Brittle; misses variants; breaks with new foods | Use the Community Food Intelligence Knowledge Graph and `buildFoodResolver()` |
