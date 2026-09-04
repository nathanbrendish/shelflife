# ADR-003: Server Actions Instead of a REST API

**Status:** Accepted  
**Date:** July 2026  
**Deciders:** Engineering lead  
**Repository Path:** `/src/app/actions/`, `/src/app/api/scan-receipt/route.ts`

---

## Context

Every mutation in ShelfLife — adding a pantry item, completing a cooked meal, regenerating the shopping list, saving a meal plan — must:

1. Authenticate the caller (validate the Supabase JWT)
2. Scope the operation to the authenticated user (`user_id = auth.uid()`)
3. Perform one or more database writes
4. Invalidate the relevant cached page data (via `revalidatePath()`)
5. Return a typed success/error result to the calling UI

These are the standard requirements for a form-like server mutation. The question is: what mechanism should implement them?

---

## Problem

What mechanism should handle server-side mutations in ShelfLife?

The options are:
- **REST API** (Route Handlers via `src/app/api/`)
- **Next.js Server Actions** (`"use server"` functions in `src/app/actions/`)
- **GraphQL API** (Apollo or tRPC)
- **Third-party BFF** (separate Node.js/Express service)

---

## Decision

**Next.js Server Actions** handle all application mutations. REST Route Handlers are used only for two specialised cases:
1. `/api/scan-receipt` — binary image upload (FormData → Gemini Vision API)
2. `/auth/callback` — Supabase auth code exchange (OAuth redirect handler)

### Server Actions Architecture

All Server Actions are in `src/app/actions/`, one file per domain:

| File | Domain |
|---|---|
| `auth.ts` | Authentication: login, register, forgotPassword, resetPassword, logout |
| `pantry.ts` | Pantry: addIngredient, updatePantryItem, deleteIngredient, classifyPantryFood, getCommunityFoodDefaults |
| `meals.ts` | Meals: suggestMeals, completeCookedMeal, cookMeal, saveMeal, removeSavedMeal |
| `planner.ts` | Planner: getCurrentMealPlan, generateMealPlan, reorderMealPlanItems, replaceMealPlanItem |
| `shopping.ts` | Shopping: regenerateShoppingList, getShoppingList, toggleShoppingItem, clearCheckedItems, clearShoppingList, triggerShoppingListRegeneration |
| `shopping-list.ts` | Add Missing: addMissingIngredientsToShoppingList |
| `receipt.ts` | Receipt: saveScannedIngredients |
| `dashboard.ts` | Dashboard: getDashboardStats, getDashboardHomeData |
| `settings.ts` | Settings: updateProfile, updateEmail, changePassword, deleteAccount |
| `community-intelligence.ts` | Platform Admin: approveCommunityFood, editCommunityFood (SUPER_ADMIN only) |

### Canonical Pattern

Every mutation Server Action follows this pattern:

```typescript
"use server"

export async function exampleMutation(
  input: ExampleInput
): Promise<{ success: true } | { success: false; error: string }> {
  const { supabase, user } = await getAuthenticatedUser();

  const { error } = await supabase
    .from("table")
    .insert({ ...data, user_id: user.id });

  if (error) {
    return { success: false, error: error.message };
  }

  revalidatePath("/affected-route");
  return { success: true };
}
```

### Why Route Handlers for `/api/scan-receipt`

The receipt scanner is a deliberate exception. The client uploads a binary image via `FormData`. Gemini Vision requires the raw image bytes. Server Actions can accept FormData but the image must be converted to base64 or a buffer before the Gemini SDK can process it — this is a natural Route Handler pattern (request body as stream/buffer).

Route Handler path: `POST /api/scan-receipt` → reads `FormData` → converts image → calls Gemini Vision → returns `ParsedIngredient[]` JSON.

---

## Alternatives Considered

### REST API (Route Handlers for All Mutations)

A traditional REST API would add a Route Handler for each operation:

```
POST /api/pantry/add
PUT  /api/pantry/update
DELETE /api/pantry/delete
POST /api/meals/cook
POST /api/shopping/regenerate
...
```

| Factor | Assessment |
|---|---|
| Boilerplate | Each endpoint requires: parse body → validate → authenticate → run → return JSON |
| Auth | Must validate JWT on every handler (either middleware or manual) |
| Revalidation | No native mechanism — client must know to refetch after mutations |
| Client code | Client must use `fetch()` for mutations; React state updates are manual |
| Type safety | End-to-end types require an extra layer (tRPC or OpenAPI codegen) |

Rejected: Server Actions eliminate the request parsing, response formatting, and client-side refetch boilerplate. For a single-team product, the additional indirection has no benefit.

### tRPC

tRPC provides end-to-end type safety for a REST-like API:

| Factor | Assessment |
|---|---|
| Type safety | Excellent — full TypeScript inference from server to client |
| Boilerplate | Reduced vs raw REST; still requires router definitions and adapter setup |
| Integration | Works with Next.js but requires HTTP adapter configuration |
| Auth | Separate middleware layer for session injection |
| Revalidation | Must still manually call `router.refresh()` or rely on query invalidation |

Rejected: Server Actions provide end-to-end type safety natively (TypeScript infers the action signature). tRPC's primary advantage is type safety across an HTTP boundary — Server Actions remove that boundary entirely.

### GraphQL

| Factor | Assessment |
|---|---|
| Schema | Requires schema definition (SDL or code-first) for all types |
| Queries | Useful for flexible client-side data fetching; unnecessary for ShelfLife's fixed-schema pages |
| Mutations | Same authentication and revalidation challenges as REST |
| Complexity | Significant additional tooling (Apollo Server, resolvers, schema stitching) |

Rejected: GraphQL is most valuable for large teams with many consumers of the same API. ShelfLife has one frontend consuming one backend. The overhead is not justified.

### Separate Express/Node.js Backend

| Factor | Assessment |
|---|---|
| Separation | Clean frontend/backend separation |
| Deployment | Two deployment targets (API server + Vercel frontend) |
| Auth | Shared session must be passed between services |
| Complexity | Highest of all options |

Rejected: Unnecessary operational complexity. Server Actions run in the same Next.js process — no cross-service communication, no token forwarding.

---

## Consequences

### Positive

- Zero REST boilerplate for mutations — no body parsing, no response formatting, no client `fetch()` calls
- `revalidatePath()` handles cache invalidation automatically without client coordination
- TypeScript types are inferred end-to-end — calling a Server Action from a Client Component is fully typed
- All mutations run in a server context — `GEMINI_API_KEY` and Supabase credentials never reach the client
- `"use server"` files are a clear boundary — any file that imports from `src/app/actions/` is visibly calling a server mutation

### Negative / Trade-offs

- Server Actions are Next.js-specific — if the framework changes, all mutations must be migrated
- Server Actions are not directly testable with unit tests — the tests in `tests/recipe-shopping-list.test.mjs` test the pure library functions (e.g., `planMissingIngredientsForShoppingList`) rather than the actions themselves
- Server Actions cannot be called from outside the Next.js app (e.g., a mobile app or third-party integration)
- Server Actions serialise over HTTP — they cannot return non-serialisable values (class instances, functions)

### Mitigations

- The canonical business logic is in `src/lib/` (pure functions), not in the actions themselves. This makes the logic testable independently of the Server Action mechanism.
- If a public API is needed in the future, Route Handlers can expose the same logic (`src/lib/`) without refactoring the actions.
- The `src/lib/add-missing-ingredients-core.mjs` module (pure JavaScript) is the canonical "Add Missing" logic — it is tested directly by the Node test runner.

---

## Implementation

Key files:

| File | Purpose |
|---|---|
| `src/app/actions/` | All Server Actions (10 files) |
| `src/app/api/scan-receipt/route.ts` | Exception: binary image upload |
| `src/app/auth/callback/route.ts` | Exception: Supabase OAuth code exchange |
| `src/lib/add-missing-ingredients-core.mjs` | Pure JS business logic (testable without Next.js) |
| `src/lib/shopping-list.ts` | Pure shopping computation (testable without Next.js) |
| `src/lib/pantry-consumption.ts` | Pure pantry consumption logic |
| `src/lib/semantic-match.ts` | Pure semantic matching |

---

## Future Implications

- If ShelfLife adopts a mobile application or a public API, Route Handlers can be added to expose the same `src/lib/` logic without changing the Server Actions
- The `src/lib/` isolation of business logic is the key enabler — actions are thin orchestrators over pure functions
- Server Actions may evolve with Next.js; the pattern is currently stable as of Next.js 16.2

---

## Cross References

- [docs/api-reference.md](../api-reference.md) — Full Server Action documentation
- [docs/architecture.md](../architecture.md)
- [ADR-001: Next.js](./ADR-001-nextjs.md)
- [ADR-006: Shopping Persistence](./ADR-006-shopping-persistence.md)
- [ADR-009: Transactional Write Patterns](./ADR-009-transactional-write-patterns.md) — atomic persistence boundary for multi-write Server Actions
