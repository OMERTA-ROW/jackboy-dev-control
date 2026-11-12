// Replays scripts/omni-handoff-v1-migration.sql in PGlite and exercises the service-only omni_handoff_create RPC.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.user_roles(user_id uuid, role text);
  CREATE TABLE public.agent_projects(id uuid PRIMARY KEY, created_by uuid, enrolled boolean, repo_url text);
  CREATE TABLE public.omni_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, kind text NOT NULL,
    instructions text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'queued', sent_at timestamptz,
    guardian_verdict text NOT NULL DEFAULT 'pending', created_by uuid NOT NULL, repo text, code_request_id uuid);
  CREATE TABLE public.automation_policy(id int, paused boolean);
`);
const sql = await readFile(
  new URL("../scripts/omni-handoff-v1-migration.sql", import.meta.url),
  "utf8",
);
for (const statement of sql.split("--> statement-breakpoint")) await db.exec(statement);

const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const task = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const repo = "OMERTA-ROW/jackboy-dev-control";
const text = "Run the test suite and report results.";
const digest = createHash("sha256").update(text, "utf8").digest("hex");
const create = async (o = {}) =>
  (
    await db.query("SELECT public.omni_handoff_create($1,$2,$3,$4,$5,$6,$7) AS v", [
      o.task ?? task,
      o.client ?? "mothership",
      o.project ?? project,
      o.repo ?? repo,
      o.kind ?? "test",
      o.text ?? text,
      o.digest ?? digest,
    ])
  ).rows[0].v;
const count = async (t) => (await db.query(`SELECT count(*)::int AS n FROM public.${t}`)).rows[0].n;

beforeEach(async () => {
  await db.exec(
    "TRUNCATE public.omni_handoff_tasks, public.omni_handoff_nonces, public.omni_jobs, public.agent_projects, public.user_roles, public.automation_policy",
  );
  await db.query("INSERT INTO public.user_roles VALUES ($1,'owner')", [owner]);
  await db.query("INSERT INTO public.agent_projects VALUES ($1,$2,true,$3)", [
    project,
    owner,
    `https://github.com/${repo}`,
  ]);
  await db.exec("INSERT INTO public.automation_policy VALUES (1,false)");
});
after(() => db.close());

test("creates one queued, unsent job owned by the owner and is idempotent per task", async () => {
  const first = await create();
  assert.equal(first.outcome, "created");
  assert.equal(first.status, "queued");
  const again = await create();
  assert.deepEqual(again, { outcome: "existing", jobId: first.jobId, status: "queued" });
  const job = (
    await db.query("SELECT status, sent_at, created_by, kind, repo FROM public.omni_jobs")
  ).rows;
  assert.equal(job.length, 1);
  assert.deepEqual(job[0], {
    status: "queued",
    sent_at: null,
    created_by: owner,
    kind: "test",
    repo,
  });
});

test("refuses digest mismatch, task conflict, Kill Switch and unauthorized projects without writing", async () => {
  assert.equal((await create({ digest: "0".repeat(64) })).reason, "digest_mismatch");
  await db.exec("UPDATE public.automation_policy SET paused = true");
  assert.equal((await create()).reason, "kill_switch_on");
  await db.exec("DELETE FROM public.automation_policy");
  assert.equal((await create()).reason, "kill_switch_on", "missing policy row fails closed");
  await db.exec("INSERT INTO public.automation_policy VALUES (1,false)");
  assert.equal((await create({ repo: "acme/other" })).reason, "project_not_authorized");
  await db.exec("UPDATE public.agent_projects SET enrolled = false");
  assert.equal((await create()).reason, "project_not_authorized");
  assert.equal(await count("omni_jobs"), 0);
  await db.exec("UPDATE public.agent_projects SET enrolled = true");
  await create();
  const other = "Different instructions entirely.";
  const conflict = await create({
    text: other,
    digest: createHash("sha256").update(other).digest("hex"),
  });
  assert.equal(conflict.reason, "task_conflict");
  assert.equal(await count("omni_jobs"), 1);
});

test("requires exactly one owner", async () => {
  await db.query("INSERT INTO public.user_roles VALUES ($1,'owner')", [
    "33333333-3333-4333-8333-333333333333",
  ]);
  assert.equal((await create()).reason, "owner_unavailable");
  assert.equal(await count("omni_jobs"), 0);
});

test("tables and RPC are server-only", async () => {
  const grants = (
    await db.query(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
      WHERE table_name IN ('omni_handoff_nonces','omni_handoff_tasks') AND grantee IN ('anon','authenticated','PUBLIC')`)
  ).rows;
  assert.deepEqual(grants, []);
  const rls = (
    await db.query(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('omni_handoff_nonces','omni_handoff_tasks') ORDER BY relname`,
    )
  ).rows;
  assert.deepEqual(
    rls.map((r) => r.relrowsecurity),
    [true, true],
  );
  const exec = (
    await db.query(`SELECT has_function_privilege('authenticated', 'public.omni_handoff_create(uuid,text,uuid,text,text,text,text)', 'EXECUTE') AS a,
      has_function_privilege('anon', 'public.omni_handoff_create(uuid,text,uuid,text,text,text,text)', 'EXECUTE') AS b,
      has_function_privilege('service_role', 'public.omni_handoff_create(uuid,text,uuid,text,text,text,text)', 'EXECUTE') AS c`)
  ).rows[0];
  assert.deepEqual(exec, { a: false, b: false, c: true });
});

test("nonces are single-use", async () => {
  await db.query(
    "INSERT INTO public.omni_handoff_nonces(nonce, client_id) VALUES ($1,'mothership')",
    ["e".repeat(32)],
  );
  await assert.rejects(
    db.query("INSERT INTO public.omni_handoff_nonces(nonce, client_id) VALUES ($1,'mothership')", [
      "e".repeat(32),
    ]),
    /duplicate key/,
  );
});
