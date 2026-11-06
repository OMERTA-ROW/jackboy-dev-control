import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// This fixture always creates its own in-memory database; it cannot accept a connection URL.
// The simulated cap flag is not evidence of provider enforcement.
test("local-only CODE gate migration and rollback preserve safety controls", async () => {
  const db = new PGlite();
  const owner = "00000000-0000-4000-8000-000000000001";
  const nonOwner = "00000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.action_requests (
        id uuid PRIMARY KEY, requested_by uuid, status text, runner_claimed_at timestamptz,
        runner_run_id bigint, runner_run_attempt integer, resources jsonb, outcome text
      );
      CREATE TABLE public.user_roles (user_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE public.audit_logs (actor uuid, action text NOT NULL, detail jsonb, outcome text);
    `);
    await db.exec(await readFile("drizzle/migrations/0037_code_safety_controls.sql", "utf8"));
    await db.query("INSERT INTO public.user_roles VALUES ($1, 'owner')", [owner]);
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
      /check constraint/i,
    );

    await db.exec(await readFile("tests/fixtures/code-local-staging-up.sql", "utf8"));
    const control = await db.query(`
      SELECT enabled, kill_switch, provider_hard_cap_verified, daily_spend_limit_usd::float AS limit
      FROM public.code_runtime_controls
    `);
    assert.deepEqual(control.rows[0], {
      enabled: false,
      kill_switch: true,
      provider_hard_cap_verified: false,
      limit: 5,
    });
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET daily_spend_limit_usd = 5.01"),
      /check constraint/i,
    );
    const privileges = await db.query(`
      SELECT has_function_privilege('authenticated', 'public.engage_code_kill_switch(uuid)', 'EXECUTE') AS auth,
             has_function_privilege('service_role', 'public.engage_code_kill_switch(uuid)', 'EXECUTE') AS service
    `);
    assert.deepEqual(privileges.rows[0], { auth: false, service: true });
    await assert.rejects(
      db.query("SELECT * FROM public.engage_code_kill_switch($1)", [nonOwner]),
      /only the owner/i,
    );
    await db.query("SELECT * FROM public.engage_code_kill_switch($1)", [owner]);
    const audit = await db.query(
      "SELECT count(*)::int AS n FROM public.audit_logs WHERE action = 'code.emergency_stop'",
    );
    assert.equal(audit.rows[0].n, 1);
    await db.exec(`
      UPDATE public.code_runtime_controls SET enabled = true, kill_switch = false;
      CREATE FUNCTION public.reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER reject_test_audit BEFORE INSERT ON public.audit_logs
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_audit();
    `);
    await assert.rejects(
      db.query("SELECT * FROM public.engage_code_kill_switch($1)", [owner]),
      /synthetic audit failure/,
    );
    const afterFailedAudit = await db.query(
      "SELECT enabled, kill_switch FROM public.code_runtime_controls",
    );
    assert.deepEqual(afterFailedAudit.rows[0], { enabled: true, kill_switch: false });
    await db.exec(`
      DROP TRIGGER reject_test_audit ON public.audit_logs;
      UPDATE public.code_runtime_controls SET enabled = false, kill_switch = true;
    `);

    // Simulate a verified flag only in this isolated fixture and prove rollback fails closed.
    await db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true");
    const rollback = await readFile("tests/fixtures/code-local-staging-down.sql", "utf8");
    await assert.rejects(db.exec(rollback), /check constraint/i);
    await db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = false");
    await db.exec(rollback);
    await assert.rejects(
      db.query("UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true"),
      /check constraint/i,
    );
  } finally {
    await db.close();
  }
});
