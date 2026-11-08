// Isolated database test for owner-scoped OMNI handoffs and JAX drafts (migrations 0055 + 0056).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TYPE app_role AS ENUM ('owner','admin','member');
  CREATE TABLE user_roles(user_id uuid, role app_role);
  GRANT SELECT ON user_roles TO authenticated;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO authenticated, anon;
  CREATE FUNCTION public.has_role(_user_id uuid, _role app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
    $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
`);
for (const f of ["0055_owner_omni_handoffs_jax_manifests.sql", "0056_owner_omni_jax_tighten_grants.sql"]) {
  const sql = (await readFile(new URL(`../drizzle/migrations/${f}`, import.meta.url), "utf8")).replaceAll("--> statement-breakpoint", "");
  await db.exec(sql);
}
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const member = "33333333-3333-4333-8333-333333333333";
await db.query("INSERT INTO user_roles VALUES ($1,'owner'),($2,'owner'),($3,'member')", [owner, other, member]);
after(() => db.close());

async function as(uid, sql, params = []) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('test.uid', '${uid}', false);`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("RESET ROLE; SELECT set_config('test.uid', '', false);");
  }
}
const addHandoff = (uid, ownerId, local = null, extra = "") =>
  as(uid, `INSERT INTO omni_research_handoffs (owner_id, source_local_id, title, status, provenance, approvals${extra ? ", original" : ""})
    VALUES ($1, $2, 'Idea', 'approved', '{"ownershipConfirmed":true,"ossReviewed":true,"noScrapedOrUnlicensed":false,"notes":""}',
    '{"publish":true,"pricing":true,"deploy":true,"sell":true}'${extra ? ", $3" : ""}) RETURNING id, approvals`, extra ? [ownerId, local, extra] : [ownerId, local]);

test("each owner sees only their own records; members and other owners cannot read or write them", async () => {
  const { rows } = await addHandoff(owner, owner, "dev-1");
  const id = rows[0].id;
  assert.equal((await as(owner, "SELECT count(*)::int n FROM omni_research_handoffs")).rows[0].n, 1);
  assert.equal((await as(other, "SELECT count(*)::int n FROM omni_research_handoffs")).rows[0].n, 0);
  assert.equal((await as(member, "SELECT count(*)::int n FROM omni_research_handoffs")).rows[0].n, 0);
  await assert.rejects(addHandoff(other, owner), /row-level security/);
  await assert.rejects(addHandoff(member, member), /row-level security/);
  const upd = await as(other, "UPDATE omni_research_handoffs SET title='x' WHERE id=$1 RETURNING id", [id]);
  assert.equal(upd.rows.length, 0);
});

test("signed-out visitors have no access and nobody can delete records", async () => {
  await db.exec("SET ROLE anon;");
  await assert.rejects(db.query("SELECT * FROM omni_research_handoffs"), /permission denied/);
  await db.exec("RESET ROLE;");
  await assert.rejects(as(owner, "DELETE FROM omni_research_handoffs"), /permission denied/);
  await assert.rejects(as(owner, "DELETE FROM jax_release_manifests"), /permission denied/);
});

test("database enforces approval rules: publish/pricing/sell need full provenance", async () => {
  const { rows } = await addHandoff(owner, owner, "dev-2");
  assert.deepEqual(rows[0].approvals, { publish: false, pricing: false, sell: false, deploy: true });
  const back = await as(owner, "UPDATE omni_research_handoffs SET status='pending' WHERE id=$1 RETURNING approvals", [rows[0].id]);
  assert.deepEqual(back.rows[0].approvals, { publish: false, pricing: false, sell: false, deploy: false });
});

test("import is idempotent per owner and the original record can never change", async () => {
  await addHandoff(owner, owner, "dev-3", JSON.stringify({ id: "dev-3", title: "Original" }));
  const again = await as(owner, `INSERT INTO omni_research_handoffs (owner_id, source_local_id, title) VALUES ($1,'dev-3','Dup')
    ON CONFLICT (owner_id, source_local_id) DO NOTHING RETURNING id`, [owner]);
  assert.equal(again.rows.length, 0);
  // Same device id under a different owner is a separate record.
  await addHandoff(other, other, "dev-3");
  await assert.rejects(as(owner, `UPDATE omni_research_handoffs SET original='{"id":"dev-3","title":"Edited"}' WHERE source_local_id='dev-3'`), /cannot be changed/);
  await assert.rejects(as(owner, `UPDATE omni_research_handoffs SET owner_id=$1 WHERE source_local_id='dev-3'`, [other]), /cannot be changed|row-level security/);
  const kept = await as(owner, "SELECT original->>'title' t FROM omni_research_handoffs WHERE source_local_id='dev-3'");
  assert.equal(kept.rows[0].t, "Original");
});

test("JAX drafts stay simulated, have no actual revenue and can only link to the owner's own handoff", async () => {
  const mine = (await addHandoff(owner, owner)).rows[0].id;
  const theirs = (await addHandoff(other, other)).rows[0].id;
  const ins = (handoff, manifest, simulated = true) =>
    as(owner, "INSERT INTO jax_release_manifests (owner_id, handoff_id, name, simulated, manifest) VALUES ($1,$2,'Pkg',$3,$4) RETURNING id", [owner, handoff, simulated, manifest]);
  await ins(mine, JSON.stringify({ simulated: true, actualRevenue: null }));
  await assert.rejects(ins(theirs, JSON.stringify({ simulated: true })), /row-level security/);
  await assert.rejects(ins(mine, JSON.stringify({ simulated: false })), /check constraint/);
  await assert.rejects(ins(mine, JSON.stringify({ simulated: true, actualRevenue: 10 })), /check constraint/);
  await assert.rejects(ins(mine, JSON.stringify({ simulated: true }), false), /check constraint/);
  assert.equal((await as(other, "SELECT count(*)::int n FROM jax_release_manifests")).rows[0].n, 0);
});
