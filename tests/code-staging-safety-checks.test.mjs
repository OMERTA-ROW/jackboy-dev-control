import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { checkSafety } from "../scripts/staging-safety-checks.mjs";
import { applyBootstrap, loadPlan } from "../scripts/staging-code-bootstrap.mjs";
import { closeAdmin, openDb, supabaseStubs } from "./helpers/staging-pg.mjs";

after(closeAdmin);
const down = await readFile("staging/code-gate/001_down.sql", "utf8");
const plan = await loadPlan();

async function setup() {
  const db = process.env.STAGING_PG_URL ? await openDb() : new PGlite();
  await db.exec(supabaseStubs);
  const role = await db.query("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role'");
  const restore = !role.rows[0].rolbypassrls;
  if (restore) await db.exec("ALTER ROLE service_role BYPASSRLS");
  await db.exec("ALTER TABLE auth.users ADD COLUMN email_confirmed_at timestamptz");
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
  await transaction((query) => applyBootstrap(query, plan, database));
  async function close() {
    if (driver) await driver.end();
    if (restore) await db.exec("ALTER ROLE service_role NOBYPASSRLS");
    await db.close();
  }
  return { db, database, transaction, close };
}

test("safety checks prove stop, audit and rollback without persisting synthetic changes", async () => {
  const { db, database, transaction, close } = await setup();
  try {
    await assert.rejects(
      transaction(async (query) => {
        await checkSafety(query, down, database);
        throw new Error("test rollback");
      }),
      /test rollback/,
    );
    const { rows } = await db.query(`
      SELECT (SELECT count(*)::int FROM public.user_roles) AS owners,
        (SELECT count(*)::int FROM public.audit_logs) AS audits,
        NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.code_runtime_controls'::regclass
          AND conname = 'code_runtime_controls_provider_hard_cap_verified_check') AS gate_unchanged
    `);
    assert.deepEqual(rows[0], { owners: 0, audits: 0, gate_unchanged: true });
  } finally {
    await close();
  }
});

test("safety checks refuse an unsafe enabled runtime", async () => {
  const { db, database, transaction, close } = await setup();
  try {
    await db.exec("UPDATE public.code_runtime_controls SET enabled = true");
    await assert.rejects(
      transaction((query) => checkSafety(query, down, database)),
      /safety_preconditions/,
    );
  } finally {
    await close();
  }
});
