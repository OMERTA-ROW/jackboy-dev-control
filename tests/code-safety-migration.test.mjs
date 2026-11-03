import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ownerId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const secondRequestId = "00000000-0000-4000-8000-000000000003";

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE TABLE public.action_requests (
      id uuid PRIMARY KEY,
      requested_by uuid NOT NULL,
      status text NOT NULL,
      runner_claimed_at timestamptz,
      runner_run_id bigint,
      runner_run_attempt integer,
      resources jsonb NOT NULL DEFAULT '{}'::jsonb,
      outcome text
    );
    CREATE TABLE public.omni_connection (config_hash text);
    CREATE TABLE public.audit_logs (
      actor uuid,
      action text NOT NULL,
      detail jsonb NOT NULL,
      outcome text NOT NULL
    );
    CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
  `);
  await db.exec(await readFile("drizzle/migrations/0036_code_runner_claims.sql", "utf8"));
  await db.exec(await readFile("drizzle/migrations/0037_code_safety_controls.sql", "utf8"));
  await db.exec(await readFile("drizzle/migrations/0038_code_provider_costs.sql", "utf8"));
  return db;
}

test("CODE database safety controls default closed and provider cap cannot be marked verified", async () => {
  const db = await createDatabase();
  try {
    const { rows } = await db.query(`
      SELECT enabled, kill_switch, provider_hard_cap_verified
      FROM public.code_runtime_controls WHERE singleton = true
    `);
    assert.deepEqual(rows[0], {
      enabled: false,
      kill_switch: true,
      provider_hard_cap_verified: false,
    });
    await assert.rejects(
      db.query(
        "UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true WHERE singleton = true",
      ),
      /check constraint/i,
    );
    const after = await db.query(
      "SELECT provider_hard_cap_verified FROM public.code_runtime_controls WHERE singleton = true",
    );
    assert.equal(after.rows[0].provider_hard_cap_verified, false);
  } finally {
    await db.close();
  }
});

test("CODE allowlist and database slot admit one authorized task under concurrent claims", async () => {
  const db = await createDatabase();
  try {
    await db.exec(`
      ALTER TABLE public.code_runtime_controls
        DROP CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check
    `);
    const workflowSha = "a".repeat(40);
    await db.query(
      `UPDATE public.code_runtime_controls
       SET enabled = true, kill_switch = false, provider_hard_cap_verified = true,
           provider_usage_at = now(),
           allowed_targets = $1::jsonb
       WHERE singleton = true`,
      [JSON.stringify({ "owner/repo": { ref: "main", workflowSha } })],
    );
    await db.query(
      `INSERT INTO public.action_requests
        (id, requested_by, status, runner_claimed_at, runner_run_id, resources)
       VALUES
        ($1, $3, 'allowed', now(), 11, $4::jsonb),
        ($2, $3, 'allowed', now(), 12, $5::jsonb)`,
      [
        requestId,
        secondRequestId,
        ownerId,
        JSON.stringify({ repo: "owner/repo", ref: "main", workflowSha }),
        JSON.stringify({ repo: "owner/repo", ref: "main", workflowSha }),
      ],
    );
    const results = await Promise.all([
      db.query(
        "SELECT public.claim_code_runtime_slot($1, 'owner/repo', 'main', $2, 11) AS claimed",
        [requestId, workflowSha],
      ),
      db.query(
        "SELECT public.claim_code_runtime_slot($1, 'owner/repo', 'main', $2, 12) AS claimed",
        [secondRequestId, workflowSha],
      ),
    ]);
    assert.deepEqual(results.map((result) => result.rows[0].claimed).sort(), [false, true]);
    const active = await db.query(
      "SELECT active_request_id FROM public.code_runtime_controls WHERE singleton = true",
    );
    assert.ok([requestId, secondRequestId].includes(active.rows[0].active_request_id));
    const unauthorized = await db.query(
      `INSERT INTO public.action_requests
        (id, requested_by, status, runner_claimed_at, runner_run_id, resources)
       VALUES ($1, $2, 'allowed', now(), 13, $3::jsonb)`,
      [
        "00000000-0000-4000-8000-000000000004",
        ownerId,
        JSON.stringify({ repo: "owner/not-allowed", ref: "main", workflowSha }),
      ],
    );
    assert.equal(unauthorized.rowCount, 1);
    const rejected = await db.query(
      `SELECT public.claim_code_runtime_slot(
        '00000000-0000-4000-8000-000000000004', 'owner/not-allowed', 'main', $1, 13
      ) AS claimed`,
      [workflowSha],
    );
    assert.equal(rejected.rows[0].claimed, false);
  } finally {
    await db.close();
  }
});

test("CODE finalization atomically records task outcome, releases slot, and trips two-failure stop", async () => {
  const db = await createDatabase();
  try {
    await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [ownerId]);
    await db.query(
      `INSERT INTO public.action_requests
        (id, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt)
       VALUES ($1, $2, 'allowed', now(), 42, 1)`,
      [requestId, ownerId],
    );
    await db.query(
      `UPDATE public.code_runtime_controls
       SET active_request_id = $1, active_run_id = 42 WHERE singleton = true`,
      [requestId],
    );
    await db.query("SELECT public.finish_code_runtime_slot($1, 42, 1, 'failure')", [requestId]);
    let result = await db.query(
      `
      SELECT controls.active_request_id, controls.consecutive_failures,
             controls.enabled, controls.kill_switch, requests.outcome
      FROM public.code_runtime_controls AS controls
      JOIN public.action_requests AS requests ON requests.id = $1
      WHERE controls.singleton = true
    `,
      [requestId],
    );
    assert.deepEqual(result.rows[0], {
      active_request_id: null,
      consecutive_failures: 1,
      enabled: false,
      kill_switch: true,
      outcome: "CODE task failure; recorded in the audit trail.",
    });

    await db.query(`UPDATE public.action_requests SET runner_run_id = 43 WHERE id = $1`, [
      requestId,
    ]);
    await db.query(
      `UPDATE public.code_runtime_controls
       SET active_request_id = $1, active_run_id = 43, consecutive_failures = 1,
           enabled = true, kill_switch = false WHERE singleton = true`,
      [requestId],
    );
    await db.query("SELECT public.finish_code_runtime_slot($1, 43, 1, 'failure')", [requestId]);
    result = await db.query(`
      SELECT consecutive_failures, enabled, kill_switch, paused_reason
      FROM public.code_runtime_controls WHERE singleton = true
    `);
    assert.deepEqual(result.rows[0], {
      consecutive_failures: 2,
      enabled: false,
      kill_switch: true,
      paused_reason: "Automatically paused after two consecutive task failures",
    });
    const audit = await db.query(
      "SELECT count(*)::integer AS count FROM public.audit_logs WHERE action = 'code.task_failure'",
    );
    assert.equal(audit.rows[0].count, 2);
  } finally {
    await db.close();
  }
});

test("CODE emergency stop distinguishes requested cancellation from confirmed cancellation", async () => {
  const db = await createDatabase();
  try {
    await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [ownerId]);
    await db.query(
      `INSERT INTO public.action_requests
        (id, requested_by, status, runner_claimed_at, runner_run_id, runner_run_attempt)
       VALUES ($1, $2, 'allowed', now(), 42, 1)`,
      [requestId, ownerId],
    );
    await db.query(
      `UPDATE public.code_runtime_controls
       SET enabled = true, kill_switch = false, active_request_id = $1, active_run_id = 42
       WHERE singleton = true`,
      [requestId],
    );
    const stopped = await db.query("SELECT * FROM public.engage_code_kill_switch($1)", [ownerId]);
    assert.deepEqual(stopped.rows[0], {
      active_request_id: requestId,
      active_run_id: 42,
    });

    let state = await db.query(
      "SELECT enabled, kill_switch, cancellation_status FROM public.code_runtime_controls",
    );
    assert.deepEqual(state.rows[0], {
      enabled: false,
      kill_switch: true,
      cancellation_status: "pending",
    });
    await db.query("SELECT public.record_code_cancellation_status($1, 'requested')", [ownerId]);
    state = await db.query("SELECT cancellation_status FROM public.code_runtime_controls");
    assert.equal(state.rows[0].cancellation_status, "requested");
    await db.query("SELECT public.record_code_cancellation_status($1, 'confirmed')", [ownerId]);
    state = await db.query("SELECT cancellation_status FROM public.code_runtime_controls");
    assert.equal(state.rows[0].cancellation_status, "confirmed");
  } finally {
    await db.close();
  }
});

test("CODE provider cost reports accept only the documented source", async () => {
  const db = await createDatabase();
  try {
    await db.query("INSERT INTO public.user_roles(user_id, role) VALUES ($1, 'owner')", [ownerId]);
    const now = new Date();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const row = {
      provider_event_id: "a".repeat(64),
      source: "openai_org_costs",
      occurred_at: dayStart,
      cost_usd: 0.25,
      request_id: null,
    };
    const sync = (rows) =>
      db.query("SELECT public.record_code_provider_costs($1, $2::jsonb, $3::timestamptz)", [
        ownerId,
        JSON.stringify(rows),
        now.toISOString(),
      ]);
    await sync([row]);
    await sync([{ ...row, cost_usd: 0.3 }]);
    const costs = await db.query(
      "SELECT count(*)::integer AS count, sum(cost_usd)::numeric AS total FROM public.code_usage_events",
    );
    assert.deepEqual(costs.rows[0], { count: 1, total: "0.300000" });
    const syncTime = await db.query(
      "SELECT provider_costs_synced_at FROM public.code_runtime_controls WHERE singleton = true",
    );
    assert.equal(new Date(syncTime.rows[0].provider_costs_synced_at).getTime(), now.getTime());
    const audit = await db.query(
      "SELECT count(*)::integer AS count FROM public.audit_logs WHERE action = 'code.provider_costs_synced'",
    );
    assert.equal(audit.rows[0].count, 2);
    await assert.rejects(
      sync([{ ...row, source: "estimated_costs" }]),
      /invalid or out-of-day rows/i,
    );
    await db.query(
      `INSERT INTO public.code_usage_events
        (provider_event_id, source, occurred_at, cost_usd)
       VALUES ('report-row', 'openai_org_costs', now(), 0.25)`,
    );
    await assert.rejects(
      db.query(
        `INSERT INTO public.code_usage_events
          (provider_event_id, source, occurred_at, cost_usd)
         VALUES ('bad-row', 'estimated_costs', now(), 0.25)`,
      ),
      /check constraint/i,
    );
    const control = await db.query(
      "SELECT provider_costs_synced_at FROM public.code_runtime_controls WHERE singleton = true",
    );
    assert.ok(control.rows[0].provider_costs_synced_at);
  } finally {
    await db.close();
  }
});
