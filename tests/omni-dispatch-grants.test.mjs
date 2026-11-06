import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE user_roles(user_id uuid, role text);
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
await db.exec(
  await readFile(
    new URL("../drizzle/migrations/0045_omni_dispatch_grants.sql", import.meta.url),
    "utf8",
  ),
);
const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const step = "44444444-4444-4444-8444-444444444444";
const action = async (op, actor = owner, grant = step) =>
  (
    await db.query("SELECT omni_dispatch_grant_action($1,$2,$3,$4) AS value", [
      op,
      actor,
      job,
      grant,
    ])
  ).rows[0].value;
beforeEach(async () => {
  await db.exec(
    "TRUNCATE omni_dispatch_callback_nonces, omni_dispatch_receipts, omni_dispatch_grants, site_log, step_up_grants, owner_passkeys, omni_jobs, agent_projects, user_roles, automation_policy",
  );
  await db.query("INSERT INTO user_roles VALUES ($1,'owner')", [owner]);
  await db.query("INSERT INTO agent_projects VALUES ($1,$2,true,'https://github.com/acme/repo')", [
    project,
    owner,
  ]);
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
});
after(() => db.close());

test("issue consumes exact owner passkey and audits atomically; revoke invalidates", async () => {
  const issued = await action("issue");
  assert.equal((await action("check", owner, issued.id)).valid, true);
  assert.equal(
    (await db.query("SELECT used_at IS NOT NULL AS used FROM step_up_grants")).rows[0].used,
    true,
  );
  assert.equal((await db.query("SELECT count(*)::int AS n FROM site_log")).rows[0].n, 1);
  await assert.rejects(action("issue"));
  assert.deepEqual(await action("revoke", owner, issued.id), { revoked: true });
  assert.equal((await action("check", owner, issued.id)).valid, false);
});

test("wrong owner, project, job type, repository, pause and expired or reused passkey fail closed", async () => {
  await assert.rejects(action("issue", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  for (const [change, restore] of [
    ["UPDATE agent_projects SET enrolled=false", "UPDATE agent_projects SET enrolled=true"],
    [
      "UPDATE agent_projects SET repo_url='https://github.com/other/repo'",
      "UPDATE agent_projects SET repo_url='https://github.com/acme/repo'",
    ],
    ["UPDATE omni_jobs SET kind='code'", "UPDATE omni_jobs SET kind='test'"],
    ["UPDATE automation_policy SET paused=true", "UPDATE automation_policy SET paused=false"],
    [
      "UPDATE step_up_grants SET expires_at=now()-interval '1 second'",
      "UPDATE step_up_grants SET expires_at=now()+interval '5 minutes'",
    ],
    ["UPDATE step_up_grants SET used_at=now()", "UPDATE step_up_grants SET used_at=NULL"],
    [
      "UPDATE step_up_grants SET target='omni-job:other'",
      `UPDATE step_up_grants SET target='omni-job:${job}'`,
    ],
    [
      "UPDATE step_up_grants SET credential_id='recent:device'",
      "UPDATE step_up_grants SET credential_id='device'",
    ],
    [
      "DELETE FROM owner_passkeys",
      "INSERT INTO owner_passkeys VALUES ('11111111-1111-4111-8111-111111111111','device')",
    ],
  ]) {
    await db.exec(change);
    await assert.rejects(action("issue"));
    await db.exec(restore);
  }
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM omni_dispatch_grants")).rows[0].n,
    0,
  );
});

test("grant revalidation rejects changed scope, expired grant and revoked owner", async () => {
  const { id } = await action("issue");
  await db.exec("UPDATE omni_jobs SET instructions='changed'");
  assert.equal((await action("check", owner, id)).valid, false);
  await db.exec(
    "UPDATE omni_jobs SET instructions='bounded request'; UPDATE automation_policy SET paused=true",
  );
  assert.equal((await action("check", owner, id)).valid, false);
  await db.exec(
    "UPDATE automation_policy SET paused=false; UPDATE omni_dispatch_grants SET expires_at=now()-interval '1 second'",
  );
  assert.equal((await action("check", owner, id)).valid, false);
  await db.exec("DELETE FROM user_roles");
  await assert.rejects(action("check", owner, id));
});

test("concurrent issuance consumes one confirmation and produces only one grant", async () => {
  const results = await Promise.allSettled([action("issue"), action("issue")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM omni_dispatch_grants")).rows[0].n,
    1,
  );
  assert.equal((await db.query("SELECT count(*)::int AS n FROM site_log")).rows[0].n, 1);
});

test("reviewed scope cannot change before passkey grant is consumed", async () => {
  const issue = (projectId, repo, instructions) =>
    db.query("SELECT omni_dispatch_issue_reviewed($1,$2,$3,$4,$5,$6) AS result", [
      owner,
      job,
      step,
      projectId,
      repo,
      instructions,
    ]);
  await assert.rejects(issue(project, "other/repo", "bounded request"));
  await assert.rejects(issue(project, "acme/repo", "other instructions"));
  await db.exec("UPDATE omni_jobs SET instructions='changed after review'");
  await assert.rejects(issue(project, "acme/repo", "bounded request"));
  assert.equal((await db.query("SELECT used_at FROM step_up_grants")).rows[0].used_at, null);
  await db.exec("UPDATE omni_jobs SET instructions='bounded request'");
  assert.equal(
    (await issue(project, "acme/repo", "bounded request")).rows[0].result.repo,
    "acme/repo",
  );
});

test("receipt persists with audit, cancellation is terminal, and revoked grants cannot record", async () => {
  const { id } = await action("issue");
  assert.deepEqual(await action("record_quarantined", owner, id), { recorded: true });
  assert.deepEqual(await action("record_cancelled", owner, id), { recorded: true });
  await assert.rejects(action("record_quarantined", owner, id));
  assert.equal(
    (await db.query("SELECT status FROM omni_dispatch_receipts")).rows[0].status,
    "cancelled",
  );
  await action("revoke", owner, id);
  await assert.rejects(action("record_cancelled", owner, id));
});

test("receipt audit failure rolls back state", async () => {
  const { id } = await action("issue");
  await db.exec("ALTER TABLE site_log ADD CONSTRAINT refuse_audit CHECK (false) NOT VALID");
  try {
    await assert.rejects(action("record_quarantined", owner, id));
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM omni_dispatch_receipts")).rows[0].n,
      0,
    );
  } finally {
    await db.exec("ALTER TABLE site_log DROP CONSTRAINT refuse_audit");
  }
});

test("callback transaction binds scope, rejects replay and rolls back nonce on audit failure", async () => {
  const { id } = await action("issue");
  const callback = (nonce, projectId = project, status = "quarantined") =>
    db.query("SELECT omni_dispatch_callback_record($1,$2,$3,$4,$5,$6,$7)", [
      nonce,
      owner,
      projectId,
      job,
      id,
      "acme/repo",
      status,
    ]);
  const nonce = "a".repeat(32);
  await assert.rejects(callback(nonce, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  await db.exec("ALTER TABLE site_log ADD CONSTRAINT refuse_audit CHECK (false) NOT VALID");
  try {
    await assert.rejects(callback(nonce));
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM omni_dispatch_callback_nonces")).rows[0].n,
      0,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM omni_dispatch_receipts")).rows[0].n,
      0,
    );
  } finally {
    await db.exec("ALTER TABLE site_log DROP CONSTRAINT refuse_audit");
  }
  await callback(nonce);
  await assert.rejects(callback(nonce));
  await callback("b".repeat(32), project, "cancelled");
  await assert.rejects(callback("c".repeat(32)));
  await action("revoke", owner, id);
  await assert.rejects(callback("d".repeat(32), project, "cancelled"));
  assert.equal(
    (await db.query("SELECT status FROM omni_dispatch_receipts")).rows[0].status,
    "cancelled",
  );
});

test("audit failure rolls back both grant and single-use passkey", async () => {
  await db.exec("ALTER TABLE site_log ADD CONSTRAINT refuse_audit CHECK (false) NOT VALID");
  try {
    await assert.rejects(action("issue"));
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM omni_dispatch_grants")).rows[0].n,
      0,
    );
    assert.equal((await db.query("SELECT used_at FROM step_up_grants")).rows[0].used_at, null);
  } finally {
    await db.exec("ALTER TABLE site_log DROP CONSTRAINT refuse_audit");
  }
});

test("browser roles cannot read grants or invoke privileged RPC", async () => {
  for (const role of ["anon", "authenticated"]) {
    assert.equal(
      (
        await db.query(
          "SELECT has_table_privilege($1,'public.omni_dispatch_grants','select') AS allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (
        await db.query(
          "SELECT has_function_privilege($1,'public.omni_dispatch_grant_action(text,uuid,uuid,uuid)','execute') AS allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
  }
});
