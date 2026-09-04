# ADR-009: Transactional Write Patterns for Multi-Step Server Actions

**Status:** Accepted
**Deployed:** September 2026 (Development + Production)
**Date:** July 2026
**Deciders:** Chief Software Architect, Engineering lead
**Repository Path:** `/src/app/actions/shopping.ts`, `/src/app/actions/planner.ts`, `/src/app/actions/meals.ts`, `/src/app/actions/receipt.ts`, `/src/app/actions/community-intelligence.ts`, `/src/lib/pantry-consumption.ts`, `/supabase/migrations/` (new RPCs)

---

## Context

ShelfLife's Server Actions are the primary application interface (see [ADR-003](./ADR-003-server-actions.md)). Many actions perform **several related writes in sequence** against Supabase over separate HTTP calls. The Supabase JS client issues each `.insert()`, `.update()`, and `.delete()` as an **independent PostgREST request** — there is no client-side transaction spanning multiple statements. If any step after the first fails (DB fault, constraint violation, network loss, cold-start timeout), the database is left in a **partially-written, inconsistent state** with no rollback.

A static QA risk assessment (13 July 2026) identified four Critical and several High candidate defects that all share this single root cause. Independent code inspection confirmed the patterns:

- **Shopping regeneration** (`shopping.ts:238`) deletes *all* of a user's `shopping_list_items`, then inserts the recomputed set. An insert failure after the delete leaves the user with a **permanently empty shopping list** (delete result is also unchecked).
- **Meal plan replacement/generation** (`planner.ts:175-213`) deletes the existing plan *before* the new plan row and its `meal_plan_items` are safely inserted. A failure between steps leaves the user with **no meal plan at all**.
- **Cooking completion** (`pantry-consumption.ts` + `meals.ts:315`) deducts pantry rows one-by-one, then inserts cooking observations, then the caller triggers shopping regeneration — **three unrelated write phases, no transaction**. Partial completion mis-states pantry quantities.
- **Receipt batch save** (`receipt.ts:151-163`) stacks/inserts items in a loop and returns on first failure, **committing all prior items** with no rollback or recovery marker.
- **Moderation** (`community-intelligence.ts:221-227`) updates `community_foods` and *then* inserts the audit row into `community_food_moderation_history` — which also currently lacks an INSERT RLS policy (see ADR-004 follow-up), so the audit insert can fail *after* the data change has already committed.
- **Reorder** (`planner.ts:252-281`) issues N sequential row updates; a mid-loop failure leaves a partially reordered plan.

The existing [ADR-006](./ADR-006-shopping-persistence.md) already acknowledges this class of risk explicitly: *"The trade-off is that concurrent Add Missing actions during regeneration could be lost. This is an accepted limitation at current scale."* That trade-off was acceptable for a single-user, low-concurrency v2.0. It is **not** acceptable as a foundation for Household Sharing (multiple concurrent writers) or for a release posture that claims data integrity.

---

## Problem

How should Server Actions that perform multiple related writes guarantee **all-or-nothing** persistence, without:

- Introducing a heavyweight ORM or a second data-access paradigm,
- Violating the Server-Actions-first principle ([ADR-003](./ADR-003-server-actions.md)),
- Weakening Row Level Security or the per-user isolation model,
- Making the eventual `user_id → household_id` migration harder,
- Adding operational complexity disproportionate to a small-team consumer app.

The core tension: the Supabase JS client cannot wrap multiple table operations in one transaction, but PostgreSQL **can** — inside a function.

---

## Decision

**Any Server Action that performs more than one dependent write MUST persist those writes atomically inside a single PostgreSQL function (RPC), invoked via `supabase.rpc()`. Computation stays in TypeScript; only the final persistence is pushed into a transactional RPC.**

### The Canonical Pattern

```
TypeScript (Server Action)                     PostgreSQL (SECURITY DEFINER RPC)
──────────────────────────                     ─────────────────────────────────
1. Authenticate (getAuthenticatedUser)
2. Fetch inputs (pantry, plan, resolver)
3. Compute the desired end-state            →  Single transaction:
   (pure functions in src/lib/)                  - validate auth.uid() = target user
4. Call supabase.rpc('do_x', { payload })  →     - perform all writes (delete+insert,
5. Map result to a safe UI contract              multi-row update, audit insert)
                                                 - COMMIT or ROLLBACK as one unit
```

This preserves the project's existing architecture: heavy business logic (semantic matching, demand computation, Knowledge Graph resolution) remains in testable TypeScript `lib/` modules; the RPC is a **thin, transactional persistence boundary** that receives an already-computed payload.

### Rules

1. **One transaction per user-visible operation.** "Regenerate shopping list", "replace meal plan", "complete cooked meal", "save receipt batch", and "moderate community food" are each a single atomic RPC.
2. **Mutate audit/history in the same transaction as the data it describes.** A data change and its moderation-history row commit together or not at all (fixes BUG-04 ordering).
3. **RPCs are `SECURITY DEFINER` with `SET search_path = public`** and MUST re-assert authorization internally (`auth.uid()` for user-owned data; an `is_super_admin()` check for platform operations). RLS is defense-in-depth, not the only gate. This matches the existing pattern in `refresh_stale_pantry_classifications()` and `delete_user_account()`.
4. **Compute-then-persist.** RPCs accept computed payloads (e.g. the final shopping rows) rather than re-implementing matching/aggregation in PL/pgSQL. No business logic is duplicated into SQL.
5. **Actions return safe result contracts** (`{ success: boolean; error?: string }`), never raw Postgres/PostgREST error strings. RPC failure maps to a single generic, user-safe message; the raw error is logged server-side only.
6. **Idempotency where a retry is plausible.** Batch saves (receipt) and toggles should tolerate re-execution without duplicating rows (paired with the unique stacking index from the concurrency initiative).

### Scope of Application

| Operation | RPC | Replaces |
|---|---|---|
| Regenerate shopping list | `regenerate_shopping_list(rows jsonb)` | delete + insert in `shopping.ts:238` |
| Replace / generate meal plan | `replace_meal_plan(p_days_count integer, p_items jsonb)` | delete + insert in `planner.ts:170-213` |
| Complete cooked meal | `complete_cooked_meal(deductions jsonb, observations jsonb)` | loop + insert in `pantry-consumption.ts` |
| Save receipt batch | `save_scanned_items(items jsonb)` | loop in `receipt.ts:151` |
| Moderate community food | `moderate_community_food(action, food_id, before, after)` | update + audit in `community-intelligence.ts` |
| Reorder meal plan items | `reorder_meal_plan_items(order jsonb)` | N updates in `planner.ts:252-281` |

Single-write actions (`toggleShoppingItem`, `deleteIngredient`, `addIngredient` when it is a lone insert/stack) do **not** require an RPC — a single statement is already atomic. They still require the **error-contract** rule (#5) and result checking.

---

## Alternatives Considered

### Application-Level "Transaction" via Sequential Calls with Manual Compensation

Keep sequential Supabase calls; on failure, run compensating writes (re-insert deleted rows, etc.).

| Factor | Assessment |
|---|---|
| Correctness | Weak — compensation itself can fail; network loss between steps leaves no chance to compensate |
| Complexity | High — every action needs bespoke rollback logic |
| Concurrency | Does not address interleaving with other sessions |

**Rejected:** Compensation-based sagas are disproportionate complexity for operations that Postgres can make atomic natively. This is the classic "distributed transaction" anti-pattern applied where a local transaction is available.

### Move Computation Into PL/pgSQL RPCs Entirely

Push demand computation, semantic matching, and Knowledge Graph resolution into SQL functions.

| Factor | Assessment |
|---|---|
| Atomicity | Achieved |
| Testability | **Poor** — matching/ranking logic is currently unit-tested in `.mjs`/TS; reimplementing in PL/pgSQL loses that and violates the testability constraint |
| Duplication | Violates "one source of truth" — logic would exist in both TS and SQL, or be ripped out of TS |
| Maintainability | PL/pgSQL is harder to debug and onboard than TypeScript for this team |

**Rejected:** Violates several engineering principles (simplicity, minimise duplication, testability). The compute-then-persist split keeps logic where it is testable.

### Adopt an ORM / Query Builder with Transaction Support (e.g. Prisma, Drizzle)

Introduce a data-access layer that supports multi-statement transactions from Node.

| Factor | Assessment |
|---|---|
| Atomicity | Achieved |
| Architectural fit | Introduces a **second** data-access paradigm alongside the Supabase client and RLS model |
| RLS | ORMs typically connect as a privileged role, **bypassing RLS** — a significant security regression for a per-user-isolated app |
| Cost | Large migration, new dependency, new failure modes |

**Rejected:** Bypassing RLS is unacceptable given the security model, and introducing a parallel ORM violates architectural consistency. Supabase RPCs give transactions while keeping RLS and a single data-access story.

### Do Nothing (Accept Current Trade-off)

Continue treating partial-write risk as an accepted limitation.

**Rejected:** Acceptable at single-user v2.0 scale, but the failures are user-visible data loss (empty shopping list, lost meal plan) and the pattern actively blocks Household Sharing. The QA assessment correctly rates these Critical.

---

## Consequences

### Positive

- Partial-write data loss (BUG-01, 02, 03, 07, 14) becomes **architecturally impossible** for covered operations.
- Audit integrity (BUG-04): a moderation change without its history row can no longer commit.
- Establishes a **single, repeatable pattern** the Lead Engineer applies to every future multi-write feature.
- Directly de-risks Household Sharing: concurrent writers now contend on transactional boundaries rather than racing between naked statements.
- Error-contract rule removes raw DB error leakage to clients as a side benefit.

### Negative / Trade-offs

- New RPCs are additive migrations that must be reviewed and kept in sync with the TypeScript payload shapes (a `jsonb` contract between TS and SQL).
- A payload-shape mismatch between the action and the RPC is a new failure mode; mitigated by shared TypeScript types and tests that assert the payload contract.
- `SECURITY DEFINER` functions require the usual hardening discipline (`SET search_path`, internal authorization) — consistent with existing functions but must not be skipped.
- Slightly more indirection: reviewers must read both the action and its RPC to understand a write path.

### Mitigations

- Each RPC re-asserts `auth.uid()` / `is_super_admin()` internally, so a mis-called RPC cannot cross user boundaries even if RLS regresses.
- CI runs the full migration chain on a clean Postgres and executes fault-injection tests that force the second write to fail and assert the first was rolled back.
- The compute-then-persist split keeps all business logic in existing unit-tested `lib/` modules; RPCs contain only writes + guards.

---

## Implementation Notes (for the Lead Engineer)

- RPCs live in a new additive migration (`015_transactional_write_rpcs.sql` or split per-domain), never by editing existing migrations ([ADR-008](./ADR-008-production-schema-reconciliation-strategy.md) rule: old migrations are immutable).
- All RPCs: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`, with an explicit `auth.uid()` guard as the first statement.
- Payloads passed as `jsonb`; unpack with `jsonb_to_recordset` for row sets.
- Verify each migration is a true no-op on Development before deploy (ADR-008 additive-reconciliation discipline).
- Do not change the read paths — `getShoppingList()` etc. remain read-only per [ADR-006](./ADR-006-shopping-persistence.md).

---

## Future Implications

- The transactional RPC boundary is the natural place to later add **optimistic-concurrency version checks** (Household Sharing) without re-architecting actions.
- A future Public API can call the same RPCs, inheriting atomicity and authorization for free.
- Once all multi-write actions use this pattern, the "accepted concurrency limitation" note in ADR-006 can be formally retired.

---

## Deferred Follow-ups (Phase 2)

**FUP-2 — `merge_community_foods` full-transaction RPC:** `mergeCommunityFoods` still reassigns and consolidates aliases and votes through separate PostgREST calls in `src/app/actions/community-intelligence.ts:326-352`. A failure between calls can leave a partially-applied merge. Phase 2 must introduce one authorization-checked transactional RPC covering alias consolidation, vote reassignment, aggregate refresh, source locking, and moderation history. This is the direct Phase-2 sibling of the Phase 1 transactional-write work; it is also tracked in the [product roadmap Known Technical Debt register](../product-roadmap.md#known-technical-debt).

BUG-10 AI rate-limiting/usage metering was subsequently resolved by [ADR-010](./ADR-010-ai-rate-limiting-usage-metering.md) and migration 016. The safe error-contract consistency sweep remains tracked in the [roadmap debt register](../product-roadmap.md#known-technical-debt) and applies [Rules #5](#rules) across residual single-write paths.

---

## Cross References

- [ADR-003: Server Actions](./ADR-003-server-actions.md)
- [ADR-004: Community Food Intelligence](./ADR-004-community-food-intelligence.md) — moderation audit RLS follow-up
- [ADR-006: Persisted Shopping Lists](./ADR-006-shopping-persistence.md) — supersedes its accepted partial-write trade-off
- [ADR-008: Production Schema Reconciliation Strategy](./ADR-008-production-schema-reconciliation-strategy.md) — additive-migration discipline
- QA Static Risk Assessment, 13 July 2026 — BUG-01, 02, 03, 04, 07, 14
