# ADR-010: AI Rate-Limiting and Usage Metering

**Status:** Accepted
**Deployed:** September 2026 (Development + Production)
**Date:** September 2026
**Deciders:** Chief Software Architect, Engineering lead
**Repository Path:** `/src/app/api/scan-receipt/route.ts`, `/src/app/actions/planner.ts`, `/src/app/actions/meals.ts`, `/src/lib/gemini/`, `/supabase/migrations/` (new usage table + RPC)

---

## Context

ShelfLife calls Google Gemini from three authenticated entry points:

- **`POST /api/scan-receipt`** — a Next.js Route Handler (`runtime = "nodejs"`, `maxDuration = 60`) that sends a receipt **image** to Gemini (the most expensive call, image input tokens).
- **Meal planning** and **meal parsing** — Server Actions that call Gemini via `withPlannerGeminiRetry` / `withGeminiRetry`.

There is currently **no per-user quota and no usage record** of any kind. The only ceiling is the provider's global 429, which `withGeminiRetry` does not even retry (it retries only 502/503/504). This exposes the project to:

- **Uncontrolled cost** — a single abusive or compromised account can drive unbounded Gemini spend.
- **No abuse resistance** — no mechanism to slow a client hammering the AI endpoints.
- **No metering substrate** — usage cannot be attributed per user, which blocks the planned Premium tier and any cost-per-user analysis.

The QA static risk assessment tracked this as **BUG-10**. Deployment is **Vercel serverless (Node runtime, not edge) + Supabase Postgres**. Because serverless invocations are ephemeral and multi-instance, **in-process/in-memory counters cannot enforce a global limit** — enforcement requires a shared, durable store. The project already operates exactly such a store (Supabase Postgres) and, in [ADR-009](./ADR-009-transactional-write-patterns.md), just established a clean `SECURITY DEFINER` atomic-RPC pattern against it.

No `profiles` / `subscriptions` / `usage` table exists yet; identity is `auth.users`. There is no billing system. The design must therefore be **tier-ready without requiring billing to exist now**.

---

## Problem

How should ShelfLife enforce per-user AI rate limits and record AI usage, without:

- Introducing a new infrastructure vendor, secret, or failure domain disproportionate to a small-team consumer app,
- Building a billing system prematurely,
- Splitting truth between two stores (a KV limiter and Postgres),
- Bypassing the per-user authorization model,
- Requiring redesign when a paid tier is later introduced.

The core tension: rate-limiting alone is a solved problem with off-the-shelf KV limiters, but the requirement is **rate-limiting *and* durable usage metering** — and solving metering well already requires Postgres.

---

## Decision

**Every AI provider call MUST be preceded by a successful atomic quota "consume" against a Postgres store, invoked via a `SECURITY DEFINER` RPC. The same store records usage for metering. Enforcement is server-side, keyed on `auth.uid()`, with per-feature limits parameterised as configuration.**

### The Canonical Pattern

```
AI entry point (route or action)              PostgreSQL (SECURITY DEFINER RPC)
────────────────────────────────              ─────────────────────────────────
1. Authenticate (auth.uid())
2. Call rpc('check_and_consume_ai_quota', →   Single transaction:
     { feature, limit, window })                 - validate auth.uid() is present
3. If over limit → short-circuit with     →     - upsert current-window counter row
     a structured, retryable-after error         - if count > limit → signal over-limit
4. Otherwise call Gemini                   →     - record usage (feature, ts, estimate)
5. Map result to a safe UI contract              - COMMIT as one unit
```

Enforcement happens **before** the Gemini call, so an over-quota request never incurs provider cost.

### Rules

1. **No AI provider call without a preceding successful quota consume.** This applies to all three current entry points and every future one.
2. **Enforcement is server-side only.** A client can never inspect, bypass, or inflate its own quota. The RPC re-asserts `auth.uid()` internally ([ADR-009](./ADR-009-transactional-write-patterns.md) Rule #3), RLS is defense-in-depth.
3. **Key on the authenticated user, never on IP.** IP-keying is wrong for an authenticated app (mobile carriers / NAT share addresses).
4. **Limits are parameterised configuration, never hard-coded per call-site.** Free-tier defaults now; a future `profiles.tier` column selects the applicable ceiling without code change.
5. **Usage rows are RLS-protected** — a user reads only their own usage; service/admin roles read all for metering.
6. **Fail-open with alarm.** If the quota check *itself* errors (DB unavailable), allow the AI call and log loudly. Availability is preferred over strict enforcement for a rare infra blip; the provider 429 remains the hard backstop. This is a deliberate, documented trade-off.
7. **Over-quota returns a safe, structured, retryable-after error** (reusing the existing `StructuredScanError` / action result contracts), never a raw store error.

### Scope of Application

| Entry point | Feature key | Notes |
|---|---|---|
| `POST /api/scan-receipt` | `receipt_scan` | Highest per-call cost (image input) |
| Meal planning action | `meal_plan` | |
| Meal parsing action | `meal_parse` | |

Non-AI actions are out of scope.

---

## Alternatives Considered

### External KV rate-limiter (Upstash Redis / Vercel KV + sliding window)

Adopt a purpose-built limiter such as `@upstash/ratelimit`.

| Factor | Assessment |
|---|---|
| Rate-limiting | Excellent — purpose-built, fast, sliding-window |
| Metering | **Not solved** — KV is ephemeral by default; durable usage attribution still needs Postgres, so you build both |
| Complexity | New vendor, new secret, new failure domain, new backup/monitoring surface |
| Truth | Split-brain: usage in KV, everything else in Postgres |
| Fit for horizon | Over-engineered for current (non-high-QPS) scale |

**Rejected for now, deferred with a trigger.** If sustained high AI throughput or measurable counter contention appears, move the *rate-limit layer* to a KV while keeping the durable usage ledger in Postgres. Not warranted at present scale.

### Edge middleware (IP / global rate limit)

Coarse limiting in Next.js middleware.

| Factor | Assessment |
|---|---|
| Per-user quota | Cannot do it — edge runtime can't cleanly reach Supabase service role; IP-keying is wrong for authenticated users |
| Value | Only a coarse DoS guard |

**Rejected as the primary mechanism.** Optional later as defense-in-depth, not a substitute for per-user quota.

### In-memory / in-process counters

Count requests in the serverless function's memory.

**Rejected:** Vercel serverless is ephemeral and multi-instance; in-memory counters cannot enforce a global per-user limit and reset on every cold start.

### Do nothing

Continue relying solely on the provider 429.

**Rejected:** Leaves cost uncontrolled, offers no abuse resistance, and provides no metering substrate for the planned tier. QA correctly flags BUG-10.

---

## Consequences

### Positive

- **Cost and abuse control** the project currently lacks: unbounded per-account AI spend becomes impossible.
- **Usage metering substrate** for the future Premium tier and cost-per-user analysis, with no new infrastructure.
- **Architectural consistency** — reuses the ADR-009 `SECURITY DEFINER` + `auth.uid()` + atomic `ON CONFLICT` idiom; near-zero onboarding cost.
- **Single source of truth** — enforcement and usage share the app's existing consistency domain; no KV/Postgres split-brain.
- **Tier-ready** — limits are configuration; a `profiles.tier` column later swaps ceilings with no redesign.

### Negative / Trade-offs

- One DB round-trip per AI call (single-digit ms against 1–60s AI calls — negligible).
- Every AI entry point must call the shared quota helper; a missed call-site leaks. Mitigated by a single shared helper and a test asserting each entry point consumes quota.
- A per-user counter row is a contention point under that user's own concurrency (bounded, self-limiting, no cross-user contention).
- Fail-open (Rule #6) means a DB outage temporarily removes enforcement; accepted and alarmed, with the provider 429 as backstop.

### Mitigations

- The RPC re-asserts `auth.uid()`, so a mis-called RPC cannot consume or read another user's quota even if RLS regresses.
- Limits centralised as configuration constants (later a table), preventing per-call-site drift.
- Usage rows are RLS-protected and indexed on `(user_id, feature, window_start)` for point reads.

---

## Implementation Notes (for the Lead Engineer)

- New **additive** migration (`016_ai_usage_and_quota.sql`), never by editing existing migrations ([ADR-008](./ADR-008-production-schema-reconciliation-strategy.md): historical migrations are immutable).
- Add a usage/counter store keyed on `(user_id, feature, window_start)` and an RPC `check_and_consume_ai_quota(p_feature text, p_limit int, p_window interval)`: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`, with an `auth.uid()` guard as the first statement, atomic upsert via `ON CONFLICT`, returning/​signalling over-limit.
- `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO authenticated`, matching the ADR-009 RPCs.
- RLS on the usage table: user selects own rows; no client INSERT/UPDATE (only the `SECURITY DEFINER` RPC writes).
- Add a single shared TypeScript helper (e.g. `consumeAiQuota(feature)`) called at the top of each AI entry point **before** any Gemini call; over-quota maps to the existing structured error contracts.
- Free-tier limit constants defined in one module; do not hard-code at call-sites (Rule #4).
- Include a self-verifying `DO $$ … $$` tail block (as migrations 012–015 do) asserting the table, RLS policy, and RPC exist.
- Verify the migration on hosted Development and capture a Dev↔Prod schema diff before any Production promotion (ADR-008 discipline).
- Add tests: (a) quota exhaustion returns the structured over-limit error and makes **no** Gemini call; (b) each entry point consumes quota; (c) fail-open path when the quota RPC errors.

---

## Future Implications

- A `profiles.tier` column (when the Premium tier lands) selects per-tier limits with no change to the enforcement mechanism.
- The usage ledger is the natural substrate for billing/invoicing when that is built (explicitly out of scope here).
- If scale demands it, the rate-limit layer can move to a KV limiter while the durable usage ledger stays in Postgres (documented trigger above).
- A future Public API can reuse the same quota RPC, inheriting enforcement and metering for free.

---

## Deferred (tracked)

- **External KV rate-limiter** — revisit only on evidence of sustained high AI throughput or measurable counter contention.
- **Billing / invoicing** — out of scope; this ADR builds only the metering substrate.
- **Edge / IP coarse DoS guard** — optional later defense-in-depth, not the primary mechanism.

---

## Cross References

- [ADR-009: Transactional Write Patterns](./ADR-009-transactional-write-patterns.md) — the `SECURITY DEFINER` RPC idiom this reuses
- [ADR-005: Semantic Matching](./ADR-005-semantic-matching.md) — an AI usage path
- [ADR-007: Canonical Food Knowledge Graph](./ADR-007-canonical-food-knowledge-graph.md) — an AI usage path
- [ADR-008: Production Schema Reconciliation Strategy](./ADR-008-production-schema-reconciliation-strategy.md) — additive-migration discipline
- [product roadmap Known Technical Debt register](../product-roadmap.md#known-technical-debt) — BUG-10 tracking entry
- QA Static Risk Assessment, 13 July 2026 — BUG-10
