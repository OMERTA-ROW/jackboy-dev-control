import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  connectionOptions,
  decodeCaCertificate,
  failureCategory,
} from "./staging-db-preflight.mjs";

const host = "shinkansen.proxy.rlwy.net";
const port = "48734";
const database = "railway";
const environmentId = "83515d1e-141f-4fd1-8dfb-50764a73a5db";
const serviceId = "f0c879d1-1934-4b5b-b4e6-728bc807d51d";

class BootstrapError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

// Explicit order includes the unjournaled baseline required by 0031. Duplicate
// journaled copies are recorded separately after their equivalence is checked.
export const migrationNames = [
  "0000_jackboy_accounts_and_audit",
  "0001_invite_tokens",
  "0002_agent_hub",
  "0003_automation_policy",
  "0004_agent_fleet",
  "0005_agent_passport",
  "0006_razul",
  "0007_update_writer",
  "0008_code_delivery_feeds",
  "0009_update_server",
  "0010_release_artifacts_policies",
  "0011_autopilot_scans",
  "0012_migration",
  "0013_migration",
  "0014_agent_memory",
  "0015_code_foundry",
  "0016_foundry_pipeline",
  "0017_site_log_outbox_research",
  "0018_capability_grants",
  "0019_update_targets",
  "0020_dedupe_proposal_notifications",
  "0021_passkey_step_up",
  "0022_action_requests",
  "0023_foundry_packages",
  "0024_project_dev_activation",
  "0025_site_monitoring",
  "0026_github_app_installations",
  "0027_passkey_rp_id",
  "0028_omni_dispatch",
  "0029_github_app_credentials",
  "0030_omni_sessions",
  "0030_repository_resync_baseline",
  "0031_repository_resync_drift_removals",
  "0032_project_github_permission_evidence_passkey_remove",
  "0033_unified_project_repository_resync",
  "0034_proposal_rejection_reason",
  "0035_task_limits_and_usage_spike",
  "0036_code_runner_claims",
  "0036_provider_permission_events",
  "0037_code_safety_controls",
  "0038_code_provider_costs",
  "0040_code_spend_reservations",
  "0041_code_spend_hold_release",
  "0042_code_provider_gateway",
];

const aliases = new Map([
  ["0039_code_runner_claims", "0036_code_runner_claims"],
  ["0040_provider_permission_events", "0036_provider_permission_events"],
  ["0041_code_spend_reservations", "0040_code_spend_reservations"],
  ["0042_code_spend_hold_release", "0041_code_spend_hold_release"],
  ["0043_code_provider_gateway", "0042_code_provider_gateway"],
]);
const extras = new Set(["0030_repository_resync_baseline"]);

export async function loadPlan() {
  const contents = new Map();
  for (const name of [...migrationNames, ...aliases.keys()]) {
    contents.set(name, await readFile(`drizzle/migrations/${name}.sql`, "utf8"));
  }
  for (const [alias, original] of aliases) {
    if (contents.get(alias).trimEnd() !== contents.get(original).trimEnd()) {
      throw new BootstrapError("migration_duplicate_mismatch");
    }
  }
  const journal = JSON.parse(await readFile("drizzle/migrations/meta/_journal.json", "utf8"));
  const entries = journal.entries.filter((entry) => entry.idx <= 43);
  const expected = new Set([
    ...migrationNames.filter((name) => !extras.has(name)),
    ...aliases.keys(),
  ]);
  // The early copies are executed, but the journal contains both early and later copies.
  for (const name of ["0036_provider_permission_events", ...aliases.values()]) {
    if (!journal.entries.some((entry) => entry.idx <= 43 && entry.tag === name))
      expected.delete(name);
  }
  if (
    entries.length !== 44 ||
    entries.some((entry, index) => entry.idx !== index || !expected.delete(entry.tag)) ||
    expected.size !== 0 ||
    entries.some(
      (entry, index) =>
        !Number.isSafeInteger(entry.when) || (index && entry.when <= entries[index - 1].when),
    )
  ) {
    throw new BootstrapError("migration_journal_mismatch");
  }
  return {
    migrations: migrationNames.map((name) => ({ name, sql: contents.get(name) })),
    journal: entries.map((entry) => ({
      when: entry.when,
      hash: createHash("sha256").update(contents.get(entry.tag)).digest("hex"),
    })),
    gate: await readFile("staging/code-gate/001_up.sql", "utf8"),
  };
}

// query returns rows and is backed by a single transaction in both production
// and the disposable PostgreSQL test harness.
export async function applyBootstrap(query, plan, expectedDatabase = database) {
  const lock = await query("SELECT pg_try_advisory_xact_lock(42202074998) AS acquired");
  if (!lock[0]?.acquired) throw new BootstrapError("concurrent_bootstrap");
  const prerequisites = await query(`
    SELECT current_database() AS database,
      to_regclass('auth.users') IS NOT NULL AS users,
      to_regprocedure('auth.uid()') IS NOT NULL AS uid,
      to_regclass('storage.objects') IS NOT NULL AS objects,
      (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) = 3 AS roles,
      (SELECT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'service_role') AS service_role_safe,
      (SELECT prorettype = 'uuid'::regtype FROM pg_proc WHERE oid = to_regprocedure('auth.uid()')) AS uid_type,
      (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('storage.objects')) AS storage_rls,
      (SELECT count(*) = 3 FROM pg_attribute WHERE attrelid = to_regclass('auth.users')
        AND attname IN ('id', 'email', 'email_confirmed_at') AND attnum > 0 AND NOT attisdropped) AS user_columns,
      (SELECT count(*) = 1 FROM pg_attribute WHERE attrelid = to_regclass('storage.objects')
        AND attname = 'bucket_id' AND attnum > 0 AND NOT attisdropped) AS storage_columns,
      to_regnamespace('drizzle') IS NULL AS journal_absent,
      NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid AND d.deptype = 'e')
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid AND d.deptype = 'e')
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype IN ('e','d','c','r','m')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
            AND d.objid = t.oid AND d.deptype = 'e')
      ) AS public_empty
  `);
  const state = prerequisites[0];
  if (
    !state ||
    state.database !== expectedDatabase ||
    !state.users ||
    !state.uid ||
    !state.objects ||
    !state.roles ||
    !state.service_role_safe ||
    !state.uid_type ||
    !state.storage_rls ||
    !state.user_columns ||
    !state.storage_columns ||
    !state.journal_absent ||
    !state.public_empty
  ) {
    throw new BootstrapError("schema_prerequisites");
  }
  for (const migration of plan.migrations) await query(migration.sql);
  await query(`
    UPDATE public.automation_policy SET paused = true WHERE id = 1;
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
    );
    CREATE TABLE public.jackboy_staging_identity (
      environment_id uuid NOT NULL, service_id uuid NOT NULL
    );
    REVOKE ALL ON public.jackboy_staging_identity FROM PUBLIC, anon, authenticated, service_role;
  `);
  for (const entry of plan.journal) {
    await query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [
      entry.hash,
      entry.when,
    ]);
  }
  await query("INSERT INTO public.jackboy_staging_identity VALUES ($1::uuid, $2::uuid)", [
    environmentId,
    serviceId,
  ]);
  await query(plan.gate);
  const result = await query(`
    SELECT enabled, kill_switch, provider_hard_cap_verified,
      daily_spend_limit_usd = 5 AS limit_ok,
      active_request_id IS NULL AND active_run_id IS NULL AS inactive,
      to_regclass('public.code_spend_reservations') IS NOT NULL AS reservations,
      to_regclass('public.code_provider_calls') IS NOT NULL AS gateway,
      (SELECT paused FROM public.automation_policy WHERE id = 1) AS automation_paused,
      NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
        conrelid = 'public.code_runtime_controls'::regclass AND
        conname = 'code_runtime_controls_provider_hard_cap_verified_check') AS gate_removed
    FROM public.code_runtime_controls WHERE singleton = true
  `);
  const controls = result[0];
  if (
    result.length !== 1 ||
    controls.enabled !== false ||
    controls.kill_switch !== true ||
    controls.provider_hard_cap_verified !== false ||
    !controls.limit_ok ||
    !controls.inactive ||
    !controls.reservations ||
    !controls.gateway ||
    !controls.automation_paused ||
    !controls.gate_removed
  ) {
    throw new BootstrapError("safety_postcondition");
  }
}

async function main() {
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "") ||
    process.env.APPROVED_COMMIT !== process.env.GITHUB_SHA ||
    process.env.STAGING_CONFIRMATION !== "verified-staging-only"
  ) {
    throw new BootstrapError("approval_input");
  }
  const plan = await loadPlan();
  const options = connectionOptions(
    process.env.STAGING_DATABASE_URL,
    host,
    port,
    database,
    decodeCaCertificate(process.env.STAGING_DB_CA_CERT),
  );
  const sql = postgres(options);
  try {
    await sql.begin(async (tx) =>
      applyBootstrap((text, params = []) => tx.unsafe(text, params), plan),
    );
    console.log("Staging bootstrap committed; CODE remains disabled and Emergency Stop engaged.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      `Staging bootstrap failed (${error instanceof BootstrapError ? error.category : failureCategory(error)}). Verify transaction outcome before retrying.`,
    );
    process.exitCode = 1;
  }
}
