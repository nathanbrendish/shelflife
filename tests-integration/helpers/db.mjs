// Shared helpers for the fault-injection integration suite (ADR-009 Phase 0
// P0-3 / Phase 1 DoD). These tests run against a real local Supabase
// Postgres instance (`supabase start`, then `supabase db reset`) — not a
// mock — because atomicity can only be proven by actually forcing a
// mid-transaction failure and checking what the database committed.
//
// Every RPC under test is `SECURITY DEFINER` and re-asserts `auth.uid()` /
// `is_super_admin()` internally by reading the standard Supabase
// `request.jwt.claims` session GUC. `actAs` sets that GUC directly via a raw
// `pg` connection, which is the standard way to exercise these functions
// without needing the full Auth/PostgREST/Kong stack running.

import pg from "pg";

const { Client } = pg;

export const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export async function withClient(fn) {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let userCounter = 0;

// Columns we explicitly supply. Anything else GoTrue adds as a NOT-NULL,
// no-default column on `auth.users` (L-2: schema drift risk, mitigated but
// not eliminated by pinning the CLI in CI — see L-1) is filled in here with
// a type-appropriate placeholder instead of failing with an opaque
// not-null-constraint error.
const KNOWN_COLUMNS = new Set([
  "id",
  "instance_id",
  "aud",
  "role",
  "email",
  "encrypted_password",
  "email_confirmed_at",
  "created_at",
  "updated_at",
  "raw_app_meta_data",
  "raw_user_meta_data",
]);

function placeholderForType(dataType) {
  switch (dataType) {
    case "boolean":
      return "false";
    case "timestamp with time zone":
    case "timestamp without time zone":
      return "now()";
    case "jsonb":
    case "json":
      return "'{}'";
    case "uuid":
      return "gen_random_uuid()";
    case "smallint":
    case "integer":
    case "bigint":
    case "numeric":
      return "0";
    default:
      // text, character varying, etc.
      return "''";
  }
}

/**
 * Inserts a throwaway `auth.users` row (required so FK-constrained tables
 * like `user_roles` / `community_food_moderation_history` accept the id) and
 * optionally grants SUPER_ADMIN. Returns the new user's id.
 *
 * Tolerant to GoTrue schema drift (L-2): any NOT-NULL, no-default column we
 * don't already supply a value for is filled with a type-appropriate
 * placeholder rather than letting the insert fail on an unrelated new
 * column.
 */
export async function createTestUser(client, { superAdmin = false } = {}) {
  userCounter += 1;
  const email = `fault-injection-${Date.now()}-${userCounter}@example.test`;

  const { rows: extraColumns } = await client.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'users'
       AND is_nullable = 'NO' AND column_default IS NULL
       AND column_name != ALL($1::text[])`,
    [Array.from(KNOWN_COLUMNS)]
  );

  const extraColumnNames = extraColumns.map((c) => c.column_name);
  const extraColumnValues = extraColumns.map((c) => placeholderForType(c.data_type));

  const columns = [
    "id",
    "instance_id",
    "aud",
    "role",
    "email",
    "encrypted_password",
    "email_confirmed_at",
    "created_at",
    "updated_at",
    "raw_app_meta_data",
    "raw_user_meta_data",
    ...extraColumnNames,
  ];
  const values = [
    "gen_random_uuid()",
    "'00000000-0000-0000-0000-000000000000'",
    "'authenticated'",
    "'authenticated'",
    "$1",
    "'x'",
    "now()",
    "now()",
    "now()",
    "'{}'",
    "'{}'",
    ...extraColumnValues,
  ];

  const { rows } = await client.query(
    `INSERT INTO auth.users (${columns.join(", ")})
     VALUES (${values.join(", ")})
     RETURNING id`,
    [email]
  );
  const userId = rows[0].id;

  if (superAdmin) {
    await client.query(
      `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'SUPER_ADMIN')`,
      [userId]
    );
  }

  return userId;
}

/** Makes subsequent queries on `client` resolve `auth.uid()` as `userId`. */
export async function actAs(client, userId) {
  // is_local=false (N-1): matches the session-wide semantics of the plain
  // `SET` statement this replaces — the claim must survive across the
  // separate implicit transactions each subsequent `client.query` call
  // opens, not just the transaction this statement itself runs in.
  await client.query(`SELECT set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
}

/** Runs `fn` and asserts it rejects — the fault-injection half of every test. */
export async function expectRejects(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to fail, but it succeeded.");
}
