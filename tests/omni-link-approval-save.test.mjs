import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../drizzle/migrations/", import.meta.url);
const file = process.env.OMNI_APPROVAL_SQL
  ?? new URL((await readdir(dir)).find((f) => /_omni_link_approval_save\.sql$/.test(f)), dir);

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE user_roles(user_id uuid, role text);
  CREATE TABLE step_up_grants(
    id uuid PRIMARY KEY, user_id uuid NOT NULL, action text NOT NULL, target text NOT NULL,
    credential_id text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz
  );
  CREATE TABLE site_log(actor text, action text, category text, status text, summary text, detail jsonb);
`);
await db.exec(await readFile(file, "utf8"));

const owner = "11111111-1111-4111-8111-111111111111";
const admin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const grant = "22222222-2222-4222-8222-222222222222";
const approval = "33333333-3333-4333-8333-333333333333";
const approval2 = "44444444-4444-4444-8444-444444444444";

beforeEach(async () => {
  await db.exec("TRUNCATE site_log, step_up_grants, user_roles, omni_link_approval");
  await db.query("INSERT INTO user_roles VALUES ($1,'owner'),($2,'admin')", [owner, admin]);
});
after(() => db.close());

const addGrant = (o = {}) =>
  db.query(
    "INSERT INTO step_up_grants VALUES ($1,$2,$3,$4,$5,now()+interval '5 minutes',NULL)",
    [o.id ?? grant, o.user ?? owner, o.action ?? "omni_link_approval_save", o.target ?? "omni-link-approval", o.cred ?? "cred-1"],
  );
const save = (o = {}) =>
  db.query("SELECT save_omni_link_approval($1,$2,$3,now()+$4::interval) AS r", [
    o.actor ?? owner, o.grant ?? grant, o.approval ?? approval, o.ahead ?? "23 hours",
  ]);
const row = async () => (await db.query("SELECT approval_id, expires_at > now() AS future FROM omni_link_approval")).rows;

test("saves ID and expiry together, consumes the passkey grant and logs without values", async () => {
  await addGrant();
  const r = (await save()).rows[0].r;
  assert.equal(r.saved, true);
  assert.equal(r.replacedPrevious, false);
  assert.deepEqual(await row(), [{ approval_id: approval, future: true }]);
  assert.ok((await db.query("SELECT used_at FROM step_up_grants")).rows[0].used_at);
  const log = JSON.stringify((await db.query("SELECT * FROM site_log")).rows);
  assert.match(log, /omni_link\.approval_saved/);
  assert.ok(!log.includes(approval));
});

test("a second save replaces the single record", async () => {
  await addGrant();
  await save();
  await addGrant({ id: "55555555-5555-4555-8555-555555555555" });
  const r = (await save({ grant: "55555555-5555-4555-8555-555555555555", approval: approval2 })).rows[0].r;
  assert.equal(r.replacedPrevious, true);
  assert.deepEqual((await row()).map((x) => x.approval_id), [approval2]);
});

for (const [name, setup, opts, msg] of [
  ["non-owner", (g) => g({ user: admin }), { actor: admin }, /Owner required/],
  ["no grant", () => {}, {}, /Fresh passkey/],
  ["grant for another action", (g) => g({ action: "omni_link_values" }), {}, /Fresh passkey/],
  ["grant for another target", (g) => g({ target: "omni-link-values" }), {}, /Fresh passkey/],
  ["recent (non-fresh) grant", (g) => g({ cred: "recent:cred-1" }), {}, /Fresh passkey/],
  ["past expiry", (g) => g(), { ahead: "-1 minute" }, /in the future/],
  ["expiry beyond 24 hours", (g) => g(), { ahead: "24 hours 1 minute" }, /within 24 hours/],
]) {
  test(`refuses ${name} and leaves the saved approval and grant untouched`, async () => {
    await setup(addGrant);
    await assert.rejects(save(opts), msg);
    assert.deepEqual(await row(), []);
    assert.equal((await db.query("SELECT count(*)::int n FROM step_up_grants WHERE used_at IS NOT NULL")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int n FROM site_log")).rows[0].n, 0);
  });
}

test("a used grant cannot save twice", async () => {
  await addGrant();
  await save();
  await assert.rejects(save({ approval: approval2 }), /Fresh passkey/);
  assert.deepEqual((await row()).map((x) => x.approval_id), [approval]);
});

test("signed-in and anonymous roles cannot read or write the record or call the save", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const r = await db.query("SELECT has_table_privilege($1,'omni_link_approval',$2) ok", [role, priv]);
      assert.equal(r.rows[0].ok, false, `${role} ${priv}`);
    }
    const f = await db.query("SELECT has_function_privilege($1,'save_omni_link_approval(uuid,uuid,uuid,timestamptz)','EXECUTE') ok", [role]);
    assert.equal(f.rows[0].ok, false);
  }
});
