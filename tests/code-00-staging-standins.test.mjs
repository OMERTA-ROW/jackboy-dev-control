import { after, test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { loadPlan, applyBootstrap } from "../scripts/staging-code-bootstrap.mjs";
import { createStandins } from "../scripts/staging-standins.mjs";
import { closeAdmin, openDb } from "./helpers/staging-pg.mjs";

after(closeAdmin);
const plan = await loadPlan();

async function setup() {
  const db = process.env.STAGING_PG_URL ? await openDb() : new PGlite();
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
          : tx.exec(sql).then((result) => result.at(-1)?.rows ?? []),
      ),
    );
  }
  async function close() {
    if (driver) await driver.end();
    await db.close();
  }
  return { db, database, transaction, close };
}

test("stand-ins bootstrap with inert identities and roll back atomically", async () => {
  const { db, database, transaction, close } = await setup();
  try {
    await assert.rejects(
      transaction(async (query) => {
        await createStandins(query);
        await applyBootstrap(query, plan, database);
        const [state] = await query(`
          SELECT auth.uid() IS NULL AS identity_absent,
            (SELECT bool_and(NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper)
             FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) AS roles_inert,
            (SELECT paused FROM public.automation_policy WHERE id = 1) AS paused,
            (SELECT NOT enabled AND kill_switch AND NOT provider_hard_cap_verified
             FROM public.code_runtime_controls WHERE singleton) AS code_stopped
        `);
        assert.deepEqual(
          { ...state },
          {
            identity_absent: true,
            roles_inert: true,
            paused: true,
            code_stopped: true,
          },
        );
        throw new Error("test rollback");
      }),
      /test rollback/,
    );
    const [state] = (
      await db.query(`
      SELECT to_regnamespace('auth') IS NULL AS auth_absent,
        to_regnamespace('storage') IS NULL AS storage_absent,
        to_regclass('public.code_runtime_controls') IS NULL AS controls_absent,
        NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) AS roles_absent
    `)
    ).rows;
    assert.deepEqual(state, {
      auth_absent: true,
      storage_absent: true,
      controls_absent: true,
      roles_absent: true,
    });
  } finally {
    await close();
  }
});

test("stand-ins refuse an existing schema without modifying it", async () => {
  const { db, transaction, close } = await setup();
  try {
    await db.exec("CREATE SCHEMA auth; CREATE TABLE auth.existing(id int)");
    await assert.rejects(
      transaction((query) => createStandins(query)),
      /standin_conflict/,
    );
    assert.ok((await db.query("SELECT to_regclass('auth.existing') AS name")).rows[0].name);
  } finally {
    await close();
  }
});

test("stand-ins refuse pre-existing cluster roles", async () => {
  const { db, transaction, close } = await setup();
  try {
    await assert.rejects(
      transaction(async (query) => {
        await query("CREATE ROLE anon NOLOGIN");
        await assert.rejects(createStandins(query), /standin_conflict/);
        const [role] = await query(
          "SELECT NOT rolcanlogin AS inert FROM pg_roles WHERE rolname = 'anon'",
        );
        assert.equal(role.inert, true);
        throw new Error("test rollback");
      }),
      /test rollback/,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'anon'")).rows[0].n,
      0,
    );
  } finally {
    await close();
  }
});
