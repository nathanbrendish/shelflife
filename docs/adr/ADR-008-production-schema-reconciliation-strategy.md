# ADR-008: Production Schema Reconciliation Strategy

**Status:** Accepted  
**Date:** July 2026  
**Deciders:** Engineering lead  
**Repository Path:** `/supabase/migrations/012_reconcile_production_schema.sql`, `/supabase/migrations/013_reconcile_production_to_development.sql`, `/supabase/migrations/014_defensive_pantry_prerequisite_guard.sql`

---

## Context

Production began raising `Could not find the 'cached_category_id' column of 'pantry' in the schema cache` at runtime. `cached_category_id` is a column that migration `007_pantry_storage_and_cache.sql` was supposed to have added to `pantry` months earlier.

Production's `supabase_migrations.schema_migrations` table reported migrations 001–011 as fully applied. A forensic, read-only audit — direct introspection of both databases' `information_schema` and `pg_catalog` (tables, columns, types, defaults, constraints, indexes, functions, triggers, RLS state, policies, grants), not a re-read of migration history — found this record did not match reality. Production was missing:

- 10 entire tables (`food_categories`, `food_subcategories`, `storage_locations`, `platform_roles`, `user_roles`, `community_foods`, `community_food_aliases`, `community_food_votes`, `community_food_moderation_history`, `cooking_behavior_observations`)
- 15 of 16 functions (only `delete_user_account()` existed)
- Its only trigger (`community_foods_classification_version`)
- 16 columns across `pantry` (8) and `shopping_list_items` (8)
- 4 foreign keys and 13 indexes
- 3 `pantry` RLS policies under Development's naming (functionally equivalent policies existed under different names)

Separately, Production carries a legacy table, `public.pantry_items`, that does not exist in Development at all and is not referenced anywhere in `src/`. It is an artifact of migration 001's table being applied to Production before it was renamed from `pantry_items` to `pantry`, with no corresponding rename ever migrated.

The underlying problem was not any single missing column — it was that **migration history had been trusted as proof of schema state**, and that trust was misplaced. A `supabase_migrations.schema_migrations` row proves a migration was *recorded* as applied; it does not prove every one of its statements actually completed against that specific database.

---

## Problem

How should Production be brought back into structural alignment with Development, given the following hard constraints:

- No destructive SQL may be executed against Production.
- No existing migration (001–011, or the already-drafted 012) may be edited once it has been applied to any environment.
- Migration history must not be edited or faked (no use of `supabase migration repair` as a substitute for actually running the missing SQL).
- Zero data loss is acceptable — this is a live production system with real user rows.
- The fix must be verifiable as a true no-op against Development, to guarantee it introduces no drift in the other direction.

---

## Decision

**Reconcile Production to Development using new, purely additive migrations, generated from Development's live introspected schema rather than replayed from historical migration source — and treat forensic schema comparison as a permanent, ongoing part of the release process, not a one-time fix.**

### Why Additive Reconciliation Migrations

Every statement in `013_reconcile_production_to_development.sql` is a `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, a guarded `CREATE POLICY` / `ADD CONSTRAINT`, or an `INSERT ... ON CONFLICT DO NOTHING`. Nothing drops, truncates, or destructively rewrites anything. This means the same migration is simultaneously:

- A real fix when run against Production (it creates what is missing).
- A verified no-op when run against Development (every statement finds its target already present and skips).

That dual property is what makes the migration safe to commit to the same file that every future `db push` (against either environment) will replay. An additive-only migration cannot make an already-correct database (Development) worse, which is the strongest guarantee obtainable without a Postgres integration test harness in CI.

### Why Historical Migrations Were Preserved

Migrations 001–012 were left completely unmodified, even 012, which was known to fail against Production on its first real attempt (see [Consequences](#deployment-sequencing-defect) below). Editing an already-drafted migration to "fix" it retroactively would have reintroduced the exact failure mode this incident was caused by: a mismatch between what a migration file claims to do and what actually happened when it ran (or didn't) against a given database. Once a migration exists and has been committed as part of the deployed history, its content is treated as an immutable historical record — corrections are made by adding a new, later migration, never by rewriting an old one.

### Why Forensic Comparison Is Now Part of the Deployment Process

The direct cause of this incident was that nobody had compared Production's *actual* schema against Development's *actual* schema — only their respective migration histories, which had silently diverged from reality. Going forward, every release that touches the database includes a read-only, catalog-level comparison of both databases (tables, columns, constraints, indexes, functions, triggers, RLS, policies), independent of what `supabase_migrations.schema_migrations` reports. Migration history is a useful hint for what *should* be true; it is no longer accepted as sufficient evidence that it *is* true.

### Why Production Data Was Never Modified Directly

Every corrective action taken was schema-level DDL or additive seed-data `INSERT ... ON CONFLICT DO NOTHING` — never a manual `UPDATE`/`DELETE` against existing user rows, and never a hand-edited row in the Supabase dashboard. Even the one-time manual pre-application of migration 013's SQL (done to unblock migration 012's dependency ordering — see below) executed the exact same idempotent SQL that is committed to the repository and later replayed by the normal `supabase db push`; it did not improvise different or looser SQL for the manual step.

### Why `pantry_items` Remains Intentionally Untouched

`public.pantry_items` is the one confirmed structural difference between Production and Development that this reconciliation does **not** eliminate. It is left alone deliberately:

- Development's correct state is for this table *not to exist* — reconciling "toward Development" here would mean dropping it, which is a destructive operation.
- It is not referenced anywhere in `src/`, so its removal carries no functional urgency.
- It may contain real historical rows from before the `pantry_items` → `pantry` rename. Dropping a table that might hold real user data is explicitly out of scope for an additive reconciliation migration and requires a separate, explicitly reviewed migration with its own sign-off.

<a name="deployment-sequencing-defect"></a>

### The Migration 012 / 013 Ordering Defect, and Why Migration 014 Exists

`012_reconcile_production_schema.sql` was drafted in an earlier, narrower investigation, before the full extent of Production's drift was known. It adds four FK-bearing `pantry` columns whose `REFERENCES` targets (`storage_locations`, `community_foods`, `food_categories`, `food_subcategories`) are only created later, by migration 013. Because Supabase migrations run in strict filename order and a runner aborts the entire batch on the first failure, 012 failed immediately against Production with `relation "public.storage_locations" does not exist`, before 013 or any later migration ever got a chance to run.

Two options were rejected outright:
1. **Edit migration 012** to add the missing dependency ordering or guards — rejected, because 012 is a historical migration and must never be rewritten.
2. **Use `supabase migration repair`** to mark 012 (or 013) applied without running it — rejected, because that fakes migration history exactly as this whole incident demonstrated is dangerous, without any independent verification that the resulting schema is actually correct.

Instead:
- **`014_defensive_pantry_prerequisite_guard.sql`** was added as a new, forward-only, permanent migration. It restates 012's four FK-bearing column additions defensively — each wrapped in `IF to_regclass(<referenced table>) IS NOT NULL THEN ... ELSE RAISE NOTICE ... END IF;` — so a missing prerequisite table is skipped with a notice instead of aborting the batch. It does not edit or supersede 012.
- **For the immediate Production deployment**, migration 013's own SQL (already verified idempotent against Development) was applied directly and honestly against Production ahead of the normal `db push`, genuinely creating the missing prerequisite tables. The subsequent `supabase db push --include-all` then ran 012, 013, and 014 for real, and all three were correctly recorded in `schema_migrations`.

**Accepted, permanent, disclosed limitation:** this arrangement cannot make migration 012 succeed on a brand-new, from-scratch replay of migration history (001 → 014) against an empty database — 012 will still fail there, before 013 or 014 ever run, because nothing numbered after 012 can prevent 012 itself from failing in that specific scenario. This does not affect Development or Production, both of which reached their current state through the one-time manual pre-application described above rather than a from-scratch replay, and is documented rather than silently accepted.

---

## Alternatives Considered

### Edit Migration 012 to Add the Missing Dependencies

| Factor | Assessment |
|---|---|
| Simplicity | Would have been the smallest diff |
| Safety | Rejected outright — 012 is a historical migration; rewriting it after the fact re-creates the exact "migration content doesn't match what actually happened" failure mode this incident is about |

### Use `supabase migration repair` to Mark 013 Applied on Production, Then Manually Run Its SQL

| Factor | Assessment |
|---|---|
| Speed | Fast — skips the ordering problem entirely |
| Safety | Rejected — `repair` marks a version as applied without Supabase's tooling ever validating the SQL ran successfully; using it here would have recorded 013 as applied based on trust rather than verification, which is precisely the failure this incident uncovered elsewhere |

### Rewrite Migration History from Scratch (Squash 001–011 into a Single Corrected Migration)

| Factor | Assessment |
|---|---|
| Cleanliness | Would produce a "clean" single source of truth |
| Safety | Rejected — requires editing/deleting every historical migration file, which is exactly the immutability rule this ADR (and general migration discipline) forbids. Also destroys the audit trail of what actually happened and when |

### Replay Every Historical Migration's Original SQL Verbatim for the Missing Objects

| Factor | Assessment |
|---|---|
| Fidelity to history | Preserves the exact original intent of each migration |
| Correctness risk | Rejected as the primary method — several objects were subsequently altered by *later* migrations (e.g. `record_community_food_observation` was rewritten by migration 006 to accept category IDs). Replaying 004's original version verbatim would have recreated an already-superseded, incorrect function signature. Reconstructing from Development's current live definition (via `pg_get_functiondef()`) guarantees the final state matches what Development actually runs today |

---

## Consequences

### Positive

- Production and Development are now structurally identical, verified by direct forensic comparison rather than by migration-history inspection alone.
- No user data was read, modified, or put at risk at any point in the reconciliation.
- The reconciliation migrations are permanently safe to re-run against either environment — both are provably idempotent.
- Historical migrations 001–012 remain untouched; the audit trail of what was originally intended is preserved exactly as written.
- Forensic schema comparison is now a standing part of the release process, reducing the chance of an equivalent drift going undetected for months again.

### Negative / Trade-offs

- The `supabase/migrations/` directory now contains three migrations (012, 013, 014) whose relationship is non-obvious from filenames alone — a reader needs the documentation (this ADR, `docs/database-schema.md` § 11, `docs/architecture.md` § 19.6) to understand why 014 exists and why it does not simply get merged into 012.
- Migration 012 remains permanently unable to succeed on a from-scratch database replay. This is disclosed rather than hidden, but it is a genuine, permanent wart in the migration chain.
- `public.pantry_items` remains as an unresolved, Production-only artifact. It is documented, not fixed, by this release.

### Mitigations

- This ADR, `docs/database-schema.md` § 11, and `docs/architecture.md` § 19.6 all cross-reference each other and explain the 012/013/014 relationship in full.
- `docs/database-schema.md` § 9 (Technical Debt) and § 10 (Future Schema Improvements) both list `pantry_items` removal as explicit, tracked future work requiring its own reviewed migration.
- `docs/developer-onboarding.md` now documents the schema-audit and safe-deployment procedure so the next engineer who encounters drift does not have to rediscover this process from scratch.

---

## Implementation

| File | Purpose |
|---|---|
| `supabase/migrations/012_reconcile_production_schema.sql` | Original, narrower `pantry` reconciliation (category/subcategory + storage/classification cache columns). Left unmodified; superseded in effect (not in content) by 013/014 |
| `supabase/migrations/013_reconcile_production_to_development.sql` | Comprehensive additive reconciliation of all forensically-discovered drift. Verified no-op on Development |
| `supabase/migrations/014_defensive_pantry_prerequisite_guard.sql` | Forward-only defensive hardening of 012's undeclared prerequisite dependency |
| `docs/database-schema.md` § 11 | Full forensic findings, root cause, and reconciliation record |
| `docs/architecture.md` § 19.6 | Architecture-level summary and permanent process changes |
| `docs/release-notes.md` § 6 | Release-facing account: problem, root cause, solution, validation, deployment, outcome |

---

## Future Implications

- Any future schema drift investigation should start with a forensic catalog-level comparison, not a migration-history check, per the process now documented in `docs/developer-onboarding.md`.
- The eventual `DROP TABLE public.pantry_items` migration and the eventual deprecated-column cleanup migration should each cite this ADR as the reason they are separate, deliberately-scoped, individually-reviewed migrations rather than being folded into any future reconciliation work.
- If a from-scratch database provisioning workflow is ever built (e.g. for automated test environments), migration 012's from-scratch limitation (documented above) must be accounted for — either by seeding a fresh database from a schema snapshot instead of a full migration replay, or by a future migration that finally supersedes 012 for that specific use case.

---

## Addendum — 13 July 2026: Migration 012 Replay Correction

The body above is retained as the original incident and decision record, but its claim that migration 012 cannot succeed on a clean, from-scratch replay is incorrect.

Migration 012 fails only when its FK-referenced tables are absent at execution time — under drifted or partially-applied migration history, as in the July 2026 Production incident where migrations 004–011 were recorded as applied but their objects were missing. It does not fail on a clean, ordered replay: migrations 004/005/007 create those prerequisites before 012 runs. A from-scratch `supabase db reset` (001→014) succeeds.

The original claim generalized an assumption from the Production drift incident and was never empirically tested; Development had reached its state through manual pre-application, not a clean replay. This is itself an instance of this ADR's central lesson: migration history and prose are not proof. The migration-chain CI job introduced under [ADR-009](./ADR-009-transactional-write-patterns.md) now performs the clean reset on every PR and is the permanent arbiter for bootstrap and disaster-recovery claims.

Migration 014 remains unchanged as an immutable deployed artifact. Its comment is retained as historical evidence; this addendum and [database-schema.md § 11](../database-schema.md#11-production-schema-reconciliation-july-2026) are the corrected living record.

---

## Cross References

- [docs/database-schema.md § 11 — Production Schema Reconciliation](../database-schema.md#11-production-schema-reconciliation-july-2026)
- [docs/architecture.md § 19.6 — Production Schema Reconciliation](../architecture.md#196-production-schema-reconciliation-july-2026)
- [docs/release-notes.md § 6 — Production Schema Reconciliation](../release-notes.md#6-production-schema-reconciliation)
- [docs/developer-onboarding.md — Database Migrations](../developer-onboarding.md#11-database-migrations)
- [ADR-002: Supabase](./ADR-002-supabase.md)
- [ADR-009: Transactional Write Patterns](./ADR-009-transactional-write-patterns.md)
