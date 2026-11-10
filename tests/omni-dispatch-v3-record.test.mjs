// Database rules for v3 dispatch status/result storage (migration 0062), run on PGlite.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
  CREATE TABLE user_roles(user_id uuid, role text);
  CREATE FUNCTION public.has_role(uuid, text) RETURNS boolean LANGUAGE sql
    AS 'SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id = $1 AND role = $2)';
  CREATE TABLE agent_projects(id uuid PRIMARY KEY, created_by uuid, enrolled boolean, repo_url text);
  CREATE TABLE omni_jobs(id uuid PRIMARY KEY, project_id uuid, kind text, repo text,
    instructions text, status text, sent_at timestamptz, code_request_id uuid);
  CREATE TABLE automation_policy(id int, paused boolean);
  CREATE TABLE owner_passkeys(user_id uuid, credential_id text);
  CREATE TABLE step_up_grants(id uuid PRIMARY KEY, user_id uuid, action text, target text,
    credential_id text, used_at timestamptz, expires_at timestamptz);
  CREATE TABLE site_log(actor text, action text, category text, status text,
    summary text, project_id uuid, detail jsonb);
`);
for (const file of ["0045_omni_dispatch_grants.sql", "0062_omni_dispatch_v3.sql", "0063_omni_dispatch_v3_late_updates.sql"])
  await db.exec(await readFile(new URL(`../drizzle/migrations/${file}`, import.meta.url), "utf8"));

const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const step = "44444444-4444-4444-8444-444444444444";
let grant = "";
const record = (status, { source = "callback", nonce, result = null, projectId = project } = {}) =>
  db
    .query("SELECT omni_dispatch_v3_record($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value", [
      source,
      source === "callback" ? (nonce ?? crypto.randomUUID().replaceAll("-", "")) : null,
      owner,
      projectId,
      job,
      grant,
      "acme/repo",
      status,
      result === null ? null : JSON.stringify(result),
    ])
    .then((r) => r.rows[0].value);
const stored = async () => (await db.query("SELECT * FROM omni_dispatch_v3_jobs")).rows;
const ok = { passed: true, summary: "all good", output: "ok acme/repo", truncated: false };

beforeEach(async () => {
  await db.exec(
    "TRUNCATE omni_dispatch_v3_jobs, omni_dispatch_callback_nonces, omni_dispatch_receipts, omni_dispatch_grants, site_log, step_up_grants, owner_passkeys, omni_jobs, agent_projects, user_roles, automation_policy",
  );
  await db.query("INSERT INTO user_roles VALUES ($1,'owner')", [owner]);
  await db.query("INSERT INTO agent_projects VALUES ($1,$2,true,'https://github.com/acme/repo')", [project, owner]);
  await db.query(
    "INSERT INTO omni_jobs VALUES ($1,$2,'test','acme/repo','bounded request','queued',NULL,NULL)",
    [job, project],
  );
  await db.exec("INSERT INTO automation_policy VALUES (1,false)");
  await db.query("INSERT INTO owner_passkeys VALUES ($1,'device')", [owner]);
  await db.query(
    "INSERT INTO step_up_grants VALUES ($1,$2,'omni_dispatch',$3,'device',NULL,now()+interval '5 minutes')",
    [step, owner, `omni-job:${job}`],
  );
  grant = (await db.query("SELECT omni_dispatch_grant_action('issue',$1,$2,$3) AS v", [owner, job, step])).rows[0].v.id;
});
after(() => db.close());

test("stores status then result with audit; job stays unsent", async () => {
  await record("quarantined", { source: "dispatch" });
  await record("running");
  assert.equal((await record("completed", { result: ok })).changed, true);
  const [row] = await stored();
  assert.equal(row.status, "completed");
  assert.deepEqual(row.result, ok);
  assert.ok(row.result_at);
  assert.equal((await db.query("SELECT count(*)::int n FROM site_log WHERE action='omni.dispatch.v3'")).rows[0].n, 3);
  assert.equal((await db.query("SELECT sent_at FROM omni_jobs")).rows[0].sent_at, null);
});

test("replayed callback nonce is refused and nothing changes", async () => {
  const nonce = "a".repeat(32);
  await record("running", { nonce });
  await assert.rejects(record("completed", { nonce, result: ok }), /replay/);
  assert.equal((await stored())[0].status, "running");
});

test("wrong scope and expired grant are refused before storing, and the nonce is not consumed", async () => {
  const nonce = "b".repeat(32);
  await assert.rejects(record("running", { nonce, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), /scope/);
  await db.exec("UPDATE omni_dispatch_grants SET expires_at = now() - interval '1 second'");
  await assert.rejects(record("running", { nonce }), /Grant unavailable/);
  assert.equal((await stored()).length, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM omni_dispatch_callback_nonces")).rows[0].n, 0);
});

test("result shape and size are enforced", async () => {
  for (const bad of [
    { ...ok, output: "x".repeat(6145) },
    { ...ok, summary: "s".repeat(501) },
    { ...ok, extra: 1 },
    { passed: "yes", summary: "", output: "", truncated: false },
  ])
    await assert.rejects(record("completed", { result: bad }), /Invalid v3 result/);
  await assert.rejects(record("running", { result: ok }), /Invalid v3 result/);
  await assert.rejects(record("approved"), /Invalid v3 callback/);
  assert.equal((await stored()).length, 0);
});

test("terminal states are final; late or repeated updates never overwrite", async () => {
  await record("completed", { result: ok });
  assert.equal((await record("running")).changed, false);
  assert.equal((await record("completed", { source: "dispatch" })).changed, false);
  assert.equal((await record("completed", { result: ok })).changed, false);
  await assert.rejects(record("completed", { result: { ...ok, passed: false } }), /conflict/);
  await assert.rejects(record("failed", { result: ok }), /conflict/);
  assert.deepEqual((await stored())[0].result, ok);
});

test("a result can fill in a terminal status first seen without one", async () => {
  await record("completed", { source: "dispatch" });
  assert.equal((await record("completed", { result: ok })).changed, true);
  assert.deepEqual((await stored())[0].result, ok);
});

test("only the service role can call the recorder", async () => {
  const grants = (
    await db.query(
      "SELECT has_function_privilege('authenticated', 'omni_dispatch_v3_record(text,text,uuid,uuid,uuid,uuid,text,text,jsonb)', 'execute') AS a, has_function_privilege('service_role', 'omni_dispatch_v3_record(text,text,uuid,uuid,uuid,uuid,text,text,jsonb)', 'execute') AS s",
    )
  ).rows[0];
  assert.deepEqual(grants, { a: false, s: true });
});
