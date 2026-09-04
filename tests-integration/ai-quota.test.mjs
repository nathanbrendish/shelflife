// ADR-010 AI rate-limiting + usage metering — integration proof against a
// real local Supabase Postgres (`supabase start` + `supabase db reset`),
// same harness as fault-injection.test.mjs. These tests exercise the
// `check_and_consume_ai_quota` RPC directly (it is `SECURITY DEFINER` and
// re-asserts `auth.uid()` internally via the standard `request.jwt.claims`
// session GUC, set here by `actAs`), proving:
//
//   (a) quota exhaustion: the Nth+1 call in a window is blocked, with a
//       positive `retry_after_seconds` — this is what every AI entry point's
//       shared `consumeAiQuota()` helper turns into a structured "over
//       limit" error and a short-circuit before any Gemini call.
//   (b) only calls that are actually let through are recorded as usage —
//       blocked attempts never reach the provider, so they aren't metered.
//   (c) the RPC's own `auth.uid()` guard rejects unauthenticated callers,
//       and per-user quota is isolated (one user's usage never affects
//       another's).
//
// The fail-open path (ADR-010 Rule #6) — what happens when the RPC call
// itself errors — is a TypeScript-layer concern (the shared `consumeAiQuota`
// helper never lets an RPC error propagate to the caller) and is covered by
// the pure-logic unit tests in tests/ai-quota.test.mjs, not here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { withClient, createTestUser, actAs, expectRejects } from "./helpers/db.mjs";

test("check_and_consume_ai_quota requires authentication", async () => {
  await withClient(async (client) => {
    // No actAs() call — request.jwt.claims is unset, so auth.uid() is NULL
    // and the RPC's first-statement guard must reject.
    await expectRejects(
      client.query(
        `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
        [`ai_quota_unauth_${Date.now()}`, 5, "1 day"]
      )
    );
  });
});

test("check_and_consume_ai_quota allows requests under the limit and blocks the one that exceeds it", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    const feature = `ai_quota_exhaustion_${Date.now()}`;
    const limit = 3;

    for (let i = 1; i <= limit; i += 1) {
      const { rows } = await client.query(
        `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
        [feature, limit, "1 day"]
      );
      assert.equal(rows[0].allowed, true, `call ${i} of ${limit} should be allowed`);
      assert.equal(rows[0].current_count, i);
      assert.equal(rows[0].quota_limit, limit);
    }

    // The (limit + 1)th call in the same window must be blocked.
    const { rows: overLimit } = await client.query(
      `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
      [feature, limit, "1 day"]
    );
    assert.equal(overLimit[0].allowed, false);
    assert.equal(overLimit[0].current_count, limit + 1);
    assert.equal(overLimit[0].quota_limit, limit);
    assert.ok(
      overLimit[0].retry_after_seconds > 0,
      "an over-limit response must carry a positive retry-after so the UI can show when to try again"
    );

    // Retrying again while still over limit must not "reset" anything —
    // the counter keeps climbing, it never grants a free extra call.
    const { rows: stillOverLimit } = await client.query(
      `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
      [feature, limit, "1 day"]
    );
    assert.equal(stillOverLimit[0].allowed, false);
    assert.equal(stillOverLimit[0].current_count, limit + 2);
  });
});

test("only calls that were actually allowed through are recorded in the usage log", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    const feature = `ai_quota_metering_${Date.now()}`;
    const limit = 2;

    // 2 allowed + 2 blocked calls.
    for (let i = 0; i < 4; i += 1) {
      await client.query(
        `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
        [feature, limit, "1 day"]
      );
    }

    const { rows: logRows } = await client.query(
      `SELECT count(*)::int AS n FROM public.ai_usage_log WHERE user_id = $1 AND feature = $2`,
      [userId, feature]
    );
    assert.equal(
      logRows[0].n,
      limit,
      "usage log must only contain the calls that were actually allowed to reach Gemini"
    );

    const { rows: counterRows } = await client.query(
      `SELECT request_count FROM public.ai_usage_counters WHERE user_id = $1 AND feature = $2`,
      [userId, feature]
    );
    assert.equal(
      counterRows[0].request_count,
      4,
      "the rate-limit counter keeps counting every attempt, allowed or not"
    );
  });
});

test("quota is isolated per user: one user's exhausted quota does not block another user", async () => {
  await withClient(async (client) => {
    const feature = `ai_quota_isolation_${Date.now()}`;
    const limit = 1;

    const userA = await createTestUser(client);
    await actAs(client, userA);
    const { rows: aFirst } = await client.query(
      `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
      [feature, limit, "1 day"]
    );
    assert.equal(aFirst[0].allowed, true);

    const { rows: aSecond } = await client.query(
      `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
      [feature, limit, "1 day"]
    );
    assert.equal(aSecond[0].allowed, false, "user A should now be over their own limit");

    const userB = await createTestUser(client);
    await actAs(client, userB);
    const { rows: bFirst } = await client.query(
      `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
      [feature, limit, "1 day"]
    );
    assert.equal(
      bFirst[0].allowed,
      true,
      "user B must get their own quota window, unaffected by user A exhausting theirs"
    );
  });
});

test("check_and_consume_ai_quota rejects an invalid limit or window rather than silently misbehaving", async () => {
  await withClient(async (client) => {
    const userId = await createTestUser(client);
    await actAs(client, userId);

    const feature = `ai_quota_invalid_args_${Date.now()}`;

    await expectRejects(
      client.query(
        `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
        [feature, 0, "1 day"]
      )
    );

    await expectRejects(
      client.query(
        `SELECT * FROM public.check_and_consume_ai_quota($1, $2, $3::interval)`,
        [feature, 5, "0 seconds"]
      )
    );
  });
});
