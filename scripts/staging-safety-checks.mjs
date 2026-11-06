import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  connectionOptions,
  decodeCaCertificate,
  failureCategory,
} from "./staging-db-preflight.mjs";

class CheckError extends Error {}
class RollbackSuccess extends Error {}

export async function checkSafety(query, down, database = "railway") {
  await query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'");
  const [locked] = await query("SELECT pg_try_advisory_xact_lock(42202074998) AS acquired");
  if (!locked?.acquired) throw new CheckError("concurrent_bootstrap");
  await query("LOCK TABLE public.jackboy_staging_identity IN SHARE MODE");
  await query("LOCK TABLE public.code_runtime_controls IN ACCESS EXCLUSIVE MODE");
  await query("LOCK TABLE public.user_roles IN SHARE ROW EXCLUSIVE MODE");
  await query("LOCK TABLE public.code_spend_reservations IN SHARE MODE");
  const [state] = await query(
    `
    SELECT current_database() = $1 AS database_matches,
      (SELECT count(*) = 1 AND count(*) FILTER (WHERE
        environment_id = '83515d1e-141f-4fd1-8dfb-50764a73a5db'::uuid AND
        service_id = 'f0c879d1-1934-4b5b-b4e6-728bc807d51d'::uuid) = 1
        FROM public.jackboy_staging_identity) AS marker_matches,
      (SELECT count(*) = 1 AND bool_and(NOT enabled AND kill_switch AND NOT provider_hard_cap_verified
        AND active_request_id IS NULL AND active_run_id IS NULL AND daily_spend_limit_usd = 5)
        FROM public.code_runtime_controls) AS stopped,
      (SELECT paused FROM public.automation_policy WHERE id = 1) AS paused,
      NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'owner') AS no_owner,
      NOT EXISTS (SELECT 1 FROM public.code_spend_reservations WHERE status <> 'settled') AS no_holds,
      NOT has_table_privilege('authenticated', 'public.code_runtime_controls', 'SELECT') AS no_control_read,
      NOT has_function_privilege('authenticated', 'public.engage_code_kill_switch(uuid)', 'EXECUTE') AS no_stop_execute,
      has_function_privilege('service_role', 'public.engage_code_kill_switch(uuid)', 'EXECUTE') AS service_stop_execute,
      auth.uid() IS NULL AS stub_identity
  `,
    [database],
  );
  if (!state || Object.values(state).some((value) => value !== true)) {
    throw new CheckError("safety_preconditions");
  }
  const owner = randomUUID();
  const nonOwner = randomUUID();
  await query("INSERT INTO auth.users (id) VALUES ($1)", [owner]);
  await query("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'owner')", [owner]);
  // A PL/pgSQL exception block isolates the expected denial from the outer transaction.
  await query(`
    DO $check$
    DECLARE denied boolean := false;
    BEGIN
      BEGIN
        PERFORM public.engage_code_kill_switch('${nonOwner}'::uuid);
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%only the owner%' THEN RAISE; END IF;
        denied := true;
      END;
      IF NOT denied THEN RAISE EXCEPTION 'non-owner stop was not denied'; END IF;
    END $check$
  `);
  await query("SELECT public.engage_code_kill_switch($1)", [owner]);
  const [audit] = await query(
    "SELECT count(*) = 1 AS recorded FROM public.audit_logs WHERE actor = $1 AND action = 'code.emergency_stop'",
    [owner],
  );
  if (!audit?.recorded) throw new CheckError("stop_audit");
  await query(down);
  const [constraint] = await query(`
    SELECT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.code_runtime_controls'::regclass
        AND conname = 'code_runtime_controls_provider_hard_cap_verified_check'
        AND convalidated AND pg_get_constraintdef(oid) = 'CHECK ((provider_hard_cap_verified = false))') AS restored
  `);
  if (!constraint?.restored) throw new CheckError("rollback_constraint");
  await query(`
    DO $check$
    DECLARE rejected boolean := false;
    BEGIN
      BEGIN
        UPDATE public.code_runtime_controls SET provider_hard_cap_verified = true WHERE singleton;
      EXCEPTION WHEN check_violation THEN rejected := true;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'rollback constraint did not reject cap flag'; END IF;
    END $check$
  `);
}

async function main() {
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "") ||
    process.env.APPROVED_COMMIT !== process.env.GITHUB_SHA ||
    process.env.STAGING_CONFIRMATION !== "verified-staging-only"
  )
    throw new CheckError("approval_input");
  const options = connectionOptions(
    process.env.STAGING_DATABASE_URL,
    "shinkansen.proxy.rlwy.net",
    "48734",
    "railway",
    decodeCaCertificate(process.env.STAGING_DB_CA_CERT),
  );
  const down = await readFile("staging/code-gate/001_down.sql", "utf8");
  const sql = postgres(options);
  try {
    try {
      await sql.begin(async (tx) => {
        await checkSafety((text, params = []) => tx.unsafe(text, params), down);
        throw new RollbackSuccess();
      });
      throw new CheckError("transaction_did_not_rollback");
    } catch (error) {
      if (!(error instanceof RollbackSuccess)) throw error;
    }
    const [post] = await sql.begin(
      "read only",
      async (tx) => tx`
      SELECT (SELECT count(*) = 1 AND bool_and(NOT enabled AND kill_switch AND
        NOT provider_hard_cap_verified AND active_request_id IS NULL AND active_run_id IS NULL)
        FROM public.code_runtime_controls) AS stopped,
        (SELECT paused FROM public.automation_policy WHERE id = 1) AS paused,
        NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'owner') AS no_owner,
        NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
          conrelid = 'public.code_runtime_controls'::regclass AND
          conname = 'code_runtime_controls_provider_hard_cap_verified_check') AS gate_unchanged
    `,
    );
    if (!post || Object.values(post).some((value) => value !== true)) {
      throw new CheckError("post_rollback_state");
    }
    console.log(
      "Staging safety checks passed; synthetic writes and rollback test were rolled back.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      `Staging safety checks failed (${error instanceof CheckError ? error.message : failureCategory(error)}). Verify staging state before retrying.`,
    );
    process.exitCode = 1;
  }
}
