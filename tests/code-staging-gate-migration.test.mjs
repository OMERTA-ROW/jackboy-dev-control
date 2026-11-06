import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { closeAdmin, openDb } from "./helpers/staging-pg.mjs";

after(closeAdmin);
const envId = "83515d1e-141f-4fd1-8dfb-50764a73a5db";
const serviceId = "f0c879d1-1934-4b5b-b4e6-728bc807d51d";
const up = await readFile("staging/code-gate/001_up.sql", "utf8");
const down = await readFile("staging/code-gate/001_down.sql", "utf8");
const migration = await readFile("drizzle/migrations/0037_code_safety_controls.sql", "utf8");

async function setup() {
  const db = process.env.STAGING_PG_URL ? await openDb() : new PGlite();
  await db.exec(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE public.action_requests (id uuid PRIMARY KEY, requested_by uuid, status text,
      runner_claimed_at timestamptz, runner_run_id bigint, runner_run_attempt integer,
      resources jsonb, outcome text);
    CREATE TABLE public.user_roles (user_id uuid, role text);
    CREATE TABLE public.audit_logs (actor uuid, action text, detail jsonb, outcome text);
  `);
  await db.exec(migration);
  return db;
}

async function marker(db, environment = envId, service = serviceId) {
  await db.exec(
    "CREATE TABLE public.jackboy_staging_identity (environment_id uuid, service_id uuid)",
  );
  await db.query("INSERT INTO public.jackboy_staging_identity VALUES ($1, $2)", [
    environment,
    service,
  ]);
}

test("staging migration refuses absent, mismatched and duplicate markers", async () => {
  const db = await setup();
  try {
    await assert.rejects(db.exec(up), /marker is missing/);
    await marker(db, "00000000-0000-4000-8000-000000000001");
    await assert.rejects(db.exec(up), /marker does not match/);
    await db.query("UPDATE public.jackboy_staging_identity SET environment_id = $1", [envId]);
    await db.query("INSERT INTO public.jackboy_staging_identity VALUES ($1, $2)", [
      envId,
      serviceId,
    ]);
    await assert.rejects(db.exec(up), /marker does not match/);
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
      /check constraint/i,
    );
  } finally {
    await db.close();
  }
});

test("staging migration preserves fail-closed defaults and restores the original constraint", async () => {
  const db = await setup();
  try {
    await marker(db);
    await db.exec(up);
    const state = await db.query(
      "SELECT enabled, kill_switch, provider_hard_cap_verified, daily_spend_limit_usd::float AS limit FROM public.code_runtime_controls",
    );
    assert.deepEqual(state.rows[0], {
      enabled: false,
      kill_switch: true,
      provider_hard_cap_verified: false,
      limit: 5,
    });
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET daily_spend_limit_usd = 5.01"),
      /check constraint/i,
    );
    await db.exec(down);
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
      /check constraint/i,
    );
  } finally {
    await db.close();
  }
});

test("migration and rollback refuse active or verified state and unsettled reservations", async () => {
  const db = await setup();
  try {
    await marker(db);
    await db.exec("UPDATE public.code_runtime_controls SET enabled = true");
    await assert.rejects(db.exec(up), /CODE must be disabled/);
    await db.exec("UPDATE public.code_runtime_controls SET enabled = false, kill_switch = false");
    await assert.rejects(db.exec(up), /CODE must be disabled/);
    await db.exec("UPDATE public.code_runtime_controls SET kill_switch = true");
    await db.exec(up);
    await assert.rejects(db.exec(up), /Expected 0037 constraint not found/);
    await db.exec("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true");
    await assert.rejects(db.exec(down), /CODE must be disabled/);
    await db.exec("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = false");
    await db.exec("CREATE TABLE public.code_spend_reservations (status text NOT NULL)");
    await db.exec("INSERT INTO public.code_spend_reservations VALUES ('reserved')");
    await assert.rejects(db.exec(down), /Unsettled CODE reservations/);
    await db.exec("UPDATE public.code_spend_reservations SET status = 'settled'");
    await db.exec(down);
  } finally {
    await db.close();
  }
});

test("unexpected 0037 constraint definition is never removed", async () => {
  const db = await setup();
  try {
    await marker(db);
    await db.exec(`
      ALTER TABLE public.code_runtime_controls
        DROP CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check;
      ALTER TABLE public.code_runtime_controls
        ADD CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check
        CHECK (provider_hard_cap_verified IS FALSE);
    `);
    await assert.rejects(db.exec(up), /Expected 0037 constraint not found/);
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
      /check constraint/i,
    );
  } finally {
    await db.close();
  }
});
