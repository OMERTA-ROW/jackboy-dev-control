// Real PostgreSQL engine (PGlite). Tests the DRAFT follow-up that lets only the
// read-only configuration check run while the Kill Switch is on.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const db = new PGlite();
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE owner_projects(id uuid primary key,created_by uuid,active boolean);
CREATE TABLE user_roles(user_id uuid,role text);
CREATE TABLE automation_policy(id int primary key,paused boolean);
CREATE TABLE omni_callback_nonces(nonce text primary key,received_at timestamptz default now());
CREATE TABLE site_log(id uuid default gen_random_uuid(),actor text,action text,category text,status text,summary text,project_id uuid,detail jsonb);`);
await db.exec(await readFile(join(root, "drizzle/migrations/0030_omni_sessions.sql"), "utf8"));
await db.exec(await readFile(join(root, "drizzle/migrations/0064_omni_configuration_probe.sql"), "utf8"));
const draft = await readFile(join(root, "scripts/omni-configuration-probe-paused-draft.sql"), "utf8");
const project = "11111111-1111-4111-8111-111111111111",
  owner = "22222222-2222-4222-8222-222222222222";
const allow = async (nonce, o = owner, client = "mothership-test") =>
  (
    await db.query("SELECT omni_link_configuration_authorize($1,$2,$3,$4) AS ok", [
      client, project, o, nonce,
    ])
  ).rows[0].ok;
const count = async (sql) => (await db.query(sql)).rows[0].n;
beforeEach(async () => {
  await db.exec("TRUNCATE omni_link_sessions,omni_inbound_jobs,omni_callback_nonces,site_log,owner_projects,user_roles,automation_policy;");
  await db.query("INSERT INTO owner_projects VALUES($1,$2,true)", [project, owner]);
  await db.query("INSERT INTO user_roles VALUES($1,'owner')", [owner]);
  await db.exec("INSERT INTO automation_policy VALUES(1,true)");
});
after(() => db.close());

test("installed 0064 refuses the configuration check while the Kill Switch is on", async () => {
  assert.equal(await allow("a".repeat(32)), false);
});

test("draft allows only the read-only check while paused, logs it, creates no work", async () => {
  await db.exec(draft);
  assert.equal(await allow("a".repeat(32)), true);
  assert.equal(await allow("a".repeat(32)), false, "nonce replay refused");
  assert.equal((await db.query("SELECT paused FROM automation_policy")).rows[0].paused, true);
  assert.equal(await count("SELECT count(*)::int n FROM omni_link_sessions"), 0);
  assert.equal(await count("SELECT count(*)::int n FROM omni_inbound_jobs"), 0);
  const logs = (await db.query("SELECT summary FROM site_log WHERE action='omni.link.configuration_check'")).rows;
  assert.equal(logs.length, 1);
  assert.match(logs[0].summary, /Kill Switch is on \(no execution\)/);
});

test("draft keeps owner, project, format and rate checks while paused", async () => {
  await db.exec(draft);
  assert.equal(await allow("b".repeat(32), "33333333-3333-4333-8333-333333333333"), false);
  assert.equal(await allow("NOT-HEX"), false);
  assert.equal(await allow("c".repeat(32), owner, "bad client!"), false);
  await db.exec("UPDATE owner_projects SET active=false");
  assert.equal(await allow("d".repeat(32)), false);
  await db.exec("UPDATE owner_projects SET active=true; DELETE FROM user_roles");
  assert.equal(await allow("e".repeat(32)), false);
  await db.query("INSERT INTO user_roles VALUES($1,'owner')", [owner]);
  for (let n = 0; n < 60; n++) assert.equal(await allow(n.toString(16).padStart(32, "0")), true);
  assert.equal(await allow("f".repeat(32)), false, "61st check in 10 minutes refused");
});

test("draft keeps browser roles locked out", async () => {
  await db.exec(draft);
  for (const role of ["anon", "authenticated"]) {
    await db.exec("SET ROLE " + role);
    await assert.rejects(allow("a".repeat(32)));
    await db.exec("RESET ROLE");
  }
});

test("draft is not journaled and contains no execution or pause writes", async () => {
  const journal = await readFile(join(root, "drizzle/migrations/meta/_journal.json"), "utf8");
  assert(!journal.includes("paused-draft"));
  assert(!/UPDATE\s+public\.automation_policy|omni_link_sessions|omni_inbound_jobs|code_runtime_controls/i.test(draft));
});
