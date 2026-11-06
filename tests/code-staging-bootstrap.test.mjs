import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { applyBootstrap, loadPlan } from "../scripts/staging-code-bootstrap.mjs";
import { closeAdmin, openDb, supabaseStubs } from "./helpers/staging-pg.mjs";

after(closeAdmin);
const plan = await loadPlan();
const down = await readFile("staging/code-gate/001_down.sql", "utf8");

test("manual bootstrap rejects an unapproved commit without logging secrets", () => {
  const result = spawnSync(process.execPath, ["scripts/staging-code-bootstrap.mjs"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      APPROVED_COMMIT: "b".repeat(40),
      STAGING_CONFIRMATION: "verified-staging-only",
      STAGING_DATABASE_URL: "sensitive-test-sentinel",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /approval_input/);
  assert.doesNotMatch(result.stdout + result.stderr, /sensitive-test-sentinel/);
});

async function setup(withPrerequisites = true) {
  const db = process.env.STAGING_PG_URL ? await openDb() : new PGlite();
  let restoreBypass = false;
  if (withPrerequisites) {
    await db.exec(supabaseStubs);
    const role = await db.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role'");
    restoreBypass = !role.rows[0].rolbypassrls;
    if (restoreBypass) await db.exec("ALTER ROLE service_role BYPASSRLS");
    await db.exec("ALTER TABLE auth.users ADD COLUMN email_confirmed_at timestamptz");
  }
  const database = (await db.query("SELECT current_database() AS name")).rows[0].name;
  const url = process.env.STAGING_PG_URL && new URL(process.env.STAGING_PG_URL);
  if (url) url.pathname = `/${database}`;
  const driver = url && postgres(url.toString(), { max: 1, prepare: false });
  async function transaction(work) {
    if (driver) return driver.begin((tx) => work((sql, params = []) => tx.unsafe(sql, params)));
    return db.transaction((tx) =>
      work((sql, params = []) =>
        params.length
          ? tx.query(sql, params).then((r) => r.rows)
          : tx.exec(sql).then((results) => results.at(-1)?.rows ?? []),
      ),
    );
  }
  async function close() {
    if (driver) await driver.end();
    if (restoreBypass) await db.exec("ALTER ROLE service_role NOBYPASSRLS");
    await db.close();
  }
  return { db, database, transaction, close };
}

test("bootstrap refuses missing prerequisites without creating application schema", async () => {
  const { db, database, transaction, close } = await setup(false);
  try {
    await assert.rejects(
      transaction((query) => applyBootstrap(query, plan, database)),
      /schema_prerequisites/,
    );
    const result = await db.query("SELECT to_regclass('public.code_runtime_controls') AS controls");
    assert.equal(result.rows[0].controls, null);
  } finally {
    await close();
  }
});

test("bootstrap applies the safe migration chain atomically and rollback restores the gate", async () => {
  const { db, database, transaction, close } = await setup();
  try {
    await transaction((query) => applyBootstrap(query, plan, database));
    const controls = await db.query(`
      SELECT enabled, kill_switch, provider_hard_cap_verified,
        daily_spend_limit_usd::float AS daily_limit
      FROM public.code_runtime_controls
    `);
    assert.deepEqual(controls.rows[0], {
      enabled: false,
      kill_switch: true,
      provider_hard_cap_verified: false,
      daily_limit: 5,
    });
    const security = await db.query(`
      SELECT has_table_privilege('authenticated', 'public.code_runtime_controls', 'SELECT') AS read_controls,
        has_table_privilege('authenticated', 'public.jackboy_staging_identity', 'SELECT') AS read_marker,
        (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations,
        to_regclass('public.code_spend_reservations') IS NOT NULL AS reservations,
        to_regclass('public.code_provider_calls') IS NOT NULL AS gateway,
        (SELECT paused FROM public.automation_policy WHERE id = 1) AS automation_paused
    `);
    assert.deepEqual(security.rows[0], {
      read_controls: false,
      read_marker: false,
      migrations: 44,
      reservations: true,
      gateway: true,
      automation_paused: true,
    });
    const owner = "00000000-0000-4000-8000-000000000001";
    const nonOwner = "00000000-0000-4000-8000-000000000002";
    await db.query("INSERT INTO auth.users (id) VALUES ($1)", [owner]);
    await db.query("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'owner')", [owner]);
    await assert.rejects(
      db.query("SELECT public.engage_code_kill_switch($1)", [nonOwner]),
      /only the owner/i,
    );
    await db.query("SELECT public.engage_code_kill_switch($1)", [owner]);
    const audit = await db.query(
      "SELECT count(*)::int AS count FROM public.audit_logs WHERE action = 'code.emergency_stop'",
    );
    assert.equal(audit.rows[0].count, 1);
    await assert.rejects(
      transaction((query) => applyBootstrap(query, plan, database)),
      /schema_prerequisites/,
    );
    await db.exec(down);
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
      /check constraint/i,
    );
  } finally {
    await close();
  }
});

test("a late bootstrap failure rolls back schema, journal and marker", async () => {
  const { db, database, transaction, close } = await setup();
  try {
    const broken = { ...plan, gate: `${plan.gate}\nSELECT 1 / 0;` };
    await assert.rejects(
      transaction((query) => applyBootstrap(query, broken, database)),
      /division by zero/,
    );
    const result = await db.query(`
      SELECT to_regclass('public.code_runtime_controls') AS controls,
        to_regclass('public.jackboy_staging_identity') AS marker,
        to_regnamespace('drizzle') AS journal
    `);
    assert.deepEqual(result.rows[0], { controls: null, marker: null, journal: null });
  } finally {
    await close();
  }
});

test("bootstrap refuses existing public data", async () => {
  const { db, database, transaction, close } = await setup();
  try {
    await db.exec("CREATE TABLE public.existing_data(id int)");
    await assert.rejects(
      transaction((query) => applyBootstrap(query, plan, database)),
      /schema_prerequisites/,
    );
    assert.ok((await db.query("SELECT to_regclass('public.existing_data') AS name")).rows[0].name);
  } finally {
    await close();
  }
});
