import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { skipNoPg, openDb, supabaseStubs, replay, closeAdmin } from "./helpers/staging-pg.mjs";

// Disposable loopback PostgreSQL only (STAGING_PG_URL). Proves the owner-only DemonTech rule:
// only the owner (or trusted server maintenance) can turn demontech_enabled on; managers can still
// turn it off and edit other columns; a missing user id alone is never trusted. Synthetic data only.
after(closeAdmin);

// Installed forward migration (live history row 85). The chain replay skips it so each test controls
// whether the rule is present; DEMONTECH_RULE_SQL can point at another candidate file for comparison.
const INSTALLED = "0076_demontech_owner_only_trigger.sql";
const RULE = process.env.DEMONTECH_RULE_SQL ?? `drizzle/migrations/${INSTALLED}`;
const rule = await readFile(new URL(`../${RULE}`, import.meta.url), "utf8");
const owner = randomUUID();
const admin = randomUUID();
const member = randomUUID();

// Real Supabase definitions (read from the live auth schema), replacing the fixed stubs.
const realAuth = `
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  DO $$ BEGIN CREATE ROLE authenticator NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  GRANT anon, authenticated, service_role TO authenticator;
  DO $$ BEGIN CREATE ROLE sandbox_like BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ALTER ROLE service_role BYPASSRLS; -- as on the live service role`;

async function setup({ install = true } = {}) {
  const db = await openDb({ connections: 4 });
  await db.exec(supabaseStubs);
  await db.exec(realAuth);
  await replay(db, { skip: [INSTALLED] });
  // Mirror the live table privileges (anon has table rights; row security blocks it).
  await db.exec(`GRANT ALL ON public.agent_projects TO anon, authenticated, service_role;
    GRANT INSERT, SELECT ON public.agent_projects TO sandbox_like;
    GRANT USAGE ON SCHEMA public TO sandbox_like;`);
  for (const [id, role] of [[owner, "owner"], [admin, "admin"], [member, "member"]]) {
    await db.query("INSERT INTO auth.users(id, email) VALUES ($1, $2)", [id, `${role}@example.test`]);
    await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, $2)", [id, role]);
  }
  const on = randomUUID();
  const off = randomUUID();
  await db.query(
    `INSERT INTO public.agent_projects(id, name, demontech_enabled, created_by) VALUES ($1,'On',true,$3), ($2,'Off',false,$3)`,
    [on, off, owner],
  );
  // A definer helper owned by the superuser that clients can call: the classic way around row security.
  await db.exec(`CREATE FUNCTION public.t_definer_enable(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
      SET search_path TO '' AS $$ UPDATE public.agent_projects SET demontech_enabled = true WHERE id = p $$;
    GRANT EXECUTE ON FUNCTION public.t_definer_enable(uuid) TO anon, authenticated;`);
  const before = await snapshot(db);
  if (install) await db.exec(`BEGIN;\n${rule}\nCOMMIT;`);
  return { db, on, off, before };
}
const snapshot = async (db) =>
  (await db.query("SELECT id, name, demontech_enabled, enrolled, angeltech_enabled FROM public.agent_projects ORDER BY id")).rows;
const state = async (db, id) =>
  (await db.query("SELECT demontech_enabled FROM public.agent_projects WHERE id=$1", [id])).rows[0]?.demontech_enabled;

// Runs one statement like the Data API: logs in as authenticator, sets request claims, switches role.
async function api(db, role, claims, sql, params = []) {
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL SESSION AUTHORIZATION authenticator");
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
    await c.query(`SET LOCAL ROLE ${role}`);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
// Runs one statement as a plain database role with no request claims (e.g. the sandbox role).
async function asRole(db, role, sql, params = []) {
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${role}`);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const user = (sub) => ({ sub, role: "authenticated" });
const refused = /Only the owner can authorize DemonTech checks/;
const enable = "UPDATE public.agent_projects SET demontech_enabled = true WHERE id = $1";
const insertOn = (by) =>
  [`INSERT INTO public.agent_projects(name, demontech_enabled, created_by) VALUES ('New', true, $1)`, [by]];

test("without the rule, a manager can turn DemonTech on (the finding)", { skip: skipNoPg }, async () => {
  const { db, off } = await setup({ install: false });
  try {
    await api(db, "authenticated", user(admin), enable, [off]);
    assert.equal(await state(db, off), true);
  } finally {
    await db.close();
  }
});

test("install changes no rows, is repeatable, and clients cannot call the rule", { skip: skipNoPg }, async () => {
  const { db, before } = await setup();
  try {
    assert.deepEqual(await snapshot(db), before);
    await db.exec(`BEGIN;\n${rule}\nCOMMIT;`);
    assert.deepEqual(await snapshot(db), before);
    const p = (await db.query(`SELECT has_function_privilege('anon','public.agent_projects_demontech_owner_only()','EXECUTE') a,
      has_function_privilege('authenticated','public.agent_projects_demontech_owner_only()','EXECUTE') b`)).rows[0];
    assert.deepEqual(p, { a: false, b: false });
  } finally {
    await db.close();
  }
});

test("owner can turn DemonTech on by update and by insert", { skip: skipNoPg }, async () => {
  const { db, off } = await setup();
  try {
    await api(db, "authenticated", user(owner), enable, [off]);
    assert.equal(await state(db, off), true);
    const [sql, params] = insertOn(owner);
    await api(db, "authenticated", user(owner), sql, params);
  } finally {
    await db.close();
  }
});

test("admin and member cannot turn DemonTech on by update or insert", { skip: skipNoPg }, async () => {
  const { db, off } = await setup();
  try {
    await assert.rejects(api(db, "authenticated", user(admin), enable, [off]), refused);
    const [sql, params] = insertOn(admin);
    await assert.rejects(api(db, "authenticated", user(admin), sql, params), refused);
    // Member: row security already hides the row; the update changes nothing.
    await api(db, "authenticated", user(member), enable, [off]);
    assert.equal(await state(db, off), false);
  } finally {
    await db.close();
  }
});

test("admin can still turn it off, edit other columns, and add projects with it off", { skip: skipNoPg }, async () => {
  const { db, on } = await setup();
  try {
    await api(db, "authenticated", user(admin), "UPDATE public.agent_projects SET name='Renamed', enrolled=true WHERE id=$1", [on]);
    assert.equal(await state(db, on), true);
    // Re-saving an already-on value is not "turning it on".
    await api(db, "authenticated", user(admin), enable, [on]);
    await api(db, "authenticated", user(admin), "UPDATE public.agent_projects SET demontech_enabled=false WHERE id=$1", [on]);
    assert.equal(await state(db, on), false);
    await api(db, "authenticated", user(admin), "INSERT INTO public.agent_projects(name, created_by) VALUES ('Plain', $1)", [admin]);
    // Once off, the admin cannot turn it back on.
    await assert.rejects(api(db, "authenticated", user(admin), enable, [on]), refused);
  } finally {
    await db.close();
  }
});

test("no user id is not trust: anon and claimless Data API calls through a definer function are refused", { skip: skipNoPg }, async () => {
  const { db, off } = await setup();
  try {
    const call = "SELECT public.t_definer_enable($1)";
    await assert.rejects(api(db, "anon", { role: "anon" }, call, [off]), refused);
    await assert.rejects(api(db, "anon", null, call, [off]), refused);
    await assert.rejects(api(db, "authenticated", { role: "authenticated" }, call, [off]), refused);
    await assert.rejects(api(db, "authenticated", user(admin), call, [off]), refused);
    assert.equal(await state(db, off), false);
    await api(db, "authenticated", user(owner), call, [off]);
    assert.equal(await state(db, off), true);
  } finally {
    await db.close();
  }
});

test("a row-security-bypassing role without a signed-in owner cannot insert DemonTech on", { skip: skipNoPg }, async () => {
  const { db } = await setup();
  try {
    const [sql, params] = insertOn(owner);
    // Live sandbox role: no access to the auth schema, so the check itself fails closed.
    await assert.rejects(asRole(db, "sandbox_like", sql, params), /permission denied for schema auth|Only the owner/);
    await db.exec("GRANT USAGE ON SCHEMA auth TO sandbox_like");
    await assert.rejects(asRole(db, "sandbox_like", sql, params), refused);
    // Inserting with DemonTech off is unaffected.
    await db.exec("REVOKE USAGE ON SCHEMA auth FROM sandbox_like");
    await asRole(db, "sandbox_like", "INSERT INTO public.agent_projects(name, created_by) VALUES ('Off', $1)", [owner]);
    assert.equal((await db.query("SELECT count(*)::int n FROM public.agent_projects WHERE demontech_enabled")).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test("trusted server maintenance still works; service role acting for a non-owner does not", { skip: skipNoPg }, async () => {
  const { db, off, on } = await setup();
  try {
    await assert.rejects(api(db, "service_role", { role: "service_role", sub: member }, enable, [off]), refused);
    await api(db, "service_role", { role: "service_role" }, enable, [off]);
    assert.equal(await state(db, off), true);
    await db.query("UPDATE public.agent_projects SET demontech_enabled=false WHERE id=$1", [on]);
    await db.query(enable, [on]); // direct superuser session (migrations, scheduled jobs)
    assert.equal(await state(db, on), true);
  } finally {
    await db.close();
  }
});
