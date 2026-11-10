import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const grant = "44444444-4444-4444-8444-444444444444";
const authorization = "55555555-5555-4555-8555-555555555555";
const digest = "a".repeat(64);

await db.exec(`
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;
  CREATE TABLE public.user_roles(user_id uuid, role text);
  CREATE TABLE public.agent_projects(id uuid PRIMARY KEY, created_by uuid, enrolled boolean, repo_url text);
  CREATE TABLE public.omni_jobs(
    id uuid PRIMARY KEY, project_id uuid, kind text, repo text, instructions text,
    status text, sent_at timestamptz, code_request_id uuid
  );
  CREATE TABLE public.omni_project_authorizations(
    id uuid PRIMARY KEY, project_id uuid, owner_id uuid, kinds text[], repo text,
    expires_at timestamptz, revoked_at timestamptz
  );
  CREATE TABLE public.omni_dispatch_grants(
    id uuid PRIMARY KEY, job_id uuid, owner_id uuid, project_id uuid, kind text,
    repo text, instructions text, expires_at timestamptz, revoked_at timestamptz,
    authorization_id uuid
  );
  CREATE FUNCTION public.omni_link_live() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.omni_dispatch_grant_action(_op text, _actor uuid, _job uuid, _grant uuid)
  RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object('valid', EXISTS (
      SELECT 1 FROM public.omni_dispatch_grants g
      WHERE g.id = _grant AND g.job_id = _job AND g.owner_id = _actor
        AND g.revoked_at IS NULL AND g.expires_at > now()
    ))
  $$;
`);
await db.exec(
  await readFile(new URL("../drizzle/migrations/0062_omni_dispatch_v3.sql", import.meta.url), "utf8"),
);

const expires = () => new Date(Date.now() + 5 * 60_000).toISOString();
const invoke = async (op, action = null, expiry = null, input = {}) => {
  const args = {
    _op: op,
    _actor: owner,
    _job: job,
    _grant: grant,
    _project: project,
    _repo: "acme/repo",
    _kind: "test",
    _digest: digest,
    _expires: expiry,
    _action: action,
    ...input,
  };
  return (
    await db.query(
      "SELECT public.omni_dispatch_v3_action($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS value",
      [
        args._op,
        args._actor,
        args._job,
        args._grant,
        args._project,
        args._repo,
        args._kind,
        args._digest,
        args._expires,
        args._action,
      ],
    )
  ).rows[0].value;
};
const callback = async (nonce, status, result = null, overrides = {}) =>
  db.query(
    "SELECT public.omni_dispatch_v3_callback_record($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value",
    [
      nonce,
      overrides.owner ?? owner,
      overrides.project ?? project,
      overrides.job ?? job,
      overrides.grant ?? grant,
      overrides.repo ?? "acme/repo",
      overrides.digest ?? digest,
      status,
      result,
    ],
  );

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.omni_dispatch_v3_callback_events, public.omni_dispatch_v3_callback_nonces,
      public.omni_dispatch_v3_jobs, public.omni_dispatch_grants,
      public.omni_project_authorizations, public.omni_jobs, public.agent_projects, public.user_roles;
  `);
  await db.query("INSERT INTO public.user_roles VALUES ($1,'owner')", [owner]);
  await db.query(
    "INSERT INTO public.agent_projects VALUES ($1,$2,true,'https://github.com/acme/repo')",
    [project, owner],
  );
  await db.query(
    "INSERT INTO public.omni_jobs VALUES ($1,$2,'test','acme/repo','approved instructions','queued',NULL,NULL)",
    [job, project],
  );
  await db.query(
    "INSERT INTO public.omni_project_authorizations VALUES ($1,$2,$3,ARRAY['test'],'acme/repo',now()+interval '1 day',NULL)",
    [authorization, project, owner],
  );
  await db.query(
    "INSERT INTO public.omni_dispatch_grants VALUES ($1,$2,$3,$4,'test','acme/repo','approved instructions',now()+interval '15 minutes',NULL,$5)",
    [grant, job, owner, project, authorization],
  );
});
after(() => db.close());

test("v3 migration stores scope and requires a current grant before prepare", async () => {
  const expiry = expires();
  assert.deepEqual(await invoke("prepare", "submit", expiry), { prepared: true });
  assert.deepEqual(await invoke("read"), {
    ownerId: owner,
    projectId: project,
    grantId: grant,
    jobId: job,
    repo: "acme/repo",
    kind: "test",
    payloadDigest: digest,
  });
  await db.query("UPDATE public.omni_dispatch_grants SET revoked_at=now() WHERE id=$1", [grant]);
  await assert.rejects(invoke("prepare", "submit", expiry), /Current owner grant unavailable/);
  assert.deepEqual(await invoke("request_cancel", "cancel"), { authorized: true });
  assert.equal(
    (await db.query("SELECT status FROM public.omni_dispatch_v3_jobs")).rows[0].status,
    "cancel_requested",
  );
  assert.deepEqual(
    (await db.query("SELECT public.omni_dispatch_v3_pending_cancellations($1) AS value", [owner]))
      .rows[0].value,
    [{ jobId: job, grantId: grant }],
  );
});

test("expired v3 jobs remain eligible for signed cancellation even while their grant is live", async () => {
  const expiry = new Date(Date.now() + 1_000).toISOString();
  await invoke("prepare", "submit", expiry);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.deepEqual(
    (
      await db.query("SELECT public.omni_dispatch_v3_pending_cancellations($1) AS value", [owner])
    ).rows[0].value,
    [{ jobId: job, grantId: grant }],
  );
});

test("fresh callback retries deduplicate logical events; nonce replay is rejected and terminal state is stable", async () => {
  await invoke("prepare", "submit", expires());
  const completed = {
    passed: true,
    summary: "Passed",
    output: "synthetic output",
    truncated: false,
  };
  await callback("a".repeat(32), "quarantined");
  await callback("b".repeat(32), "running");
  await callback("c".repeat(32), "running");
  await callback("d".repeat(32), "completed", completed);
  await callback("e".repeat(32), "quarantined");
  await callback("f".repeat(32), "running");
  await assert.rejects(callback("b".repeat(32), "running"), /Callback nonce replay/);
  await assert.rejects(
    callback("7".repeat(32), "completed", { ...completed, output: "changed" }),
    /V3 logical callback conflict/,
  );
  assert.deepEqual(
    (
      await db.query("SELECT status, result FROM public.omni_dispatch_v3_jobs WHERE job_id=$1", [
        job,
      ])
    ).rows[0],
    { status: "completed", result: completed },
  );
  assert.equal(
    (
      await db.query("SELECT count(*)::int AS n FROM public.omni_dispatch_v3_callback_events WHERE status='running'")
    ).rows[0].n,
    1,
  );
});

test("concurrent fresh retries create one logical event while each nonce is durably consumed", async () => {
  await invoke("prepare", "submit", expires());
  const outcomes = await Promise.allSettled([
    callback("1".repeat(32), "quarantined"),
    callback("2".repeat(32), "quarantined"),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(
    (
      await db.query("SELECT count(*)::int AS n FROM public.omni_dispatch_v3_callback_events")
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query("SELECT count(*)::int AS n FROM public.omni_dispatch_v3_callback_nonces")
    ).rows[0].n,
    2,
  );
  const replay = await Promise.allSettled([
    callback("3".repeat(32), "running"),
    callback("3".repeat(32), "running"),
  ]);
  assert.equal(replay.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(replay.filter((result) => result.status === "rejected").length, 1);
});

test("terminal result limits and immutable callback scope are enforced transactionally", async () => {
  await invoke("prepare", "submit", expires());
  const oversized = {
    passed: true,
    summary: "ok",
    output: "x".repeat(6145),
    truncated: false,
  };
  await assert.rejects(callback("9".repeat(32), "completed"), /Invalid terminal v3 result/);
  await assert.rejects(
    callback("8".repeat(32), "failed", {
      passed: true,
      summary: "unexpected pass",
      output: "",
      truncated: false,
    }),
    /Invalid terminal v3 result/,
  );
  await assert.rejects(callback("a".repeat(32), "completed", oversized), /Invalid terminal v3 result/);
  await assert.rejects(
    callback("b".repeat(32), "completed", {
      ...oversized,
      output: "",
      summary: "🙂".repeat(501),
    }),
    /Invalid terminal v3 result/,
  );
  await assert.rejects(
    callback("c".repeat(32), "running", null, { repo: "other/repo" }),
    /V3 callback scope unavailable/,
  );
  assert.equal(
    (
      await db.query("SELECT count(*)::int AS n FROM public.omni_dispatch_v3_callback_nonces")
    ).rows[0].n,
    0,
  );
});

test("browser roles cannot read v3 state or invoke privileged v3 RPCs", async () => {
  for (const role of ["anon", "authenticated"]) {
    assert.equal(
      (
        await db.query(
          "SELECT has_table_privilege($1,'public.omni_dispatch_v3_jobs','select') AS allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (
        await db.query(
          "SELECT has_function_privilege($1,'public.omni_dispatch_v3_action(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text)','execute') AS allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
  }
});
