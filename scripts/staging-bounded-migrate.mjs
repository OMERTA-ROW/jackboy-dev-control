import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

export const target = Object.freeze({
  host: "shinkansen.proxy.rlwy.net",
  port: 48734,
  database: "railway",
  environmentId: "83515d1e-141f-4fd1-8dfb-50764a73a5db",
  serviceId: "f0c879d1-1934-4b5b-b4e6-728bc807d51d",
});
export const cutoff = "0064_omni_configuration_probe";
export const seedSlugs = Object.freeze(["omni", "jax", "razul", "iggy"]);

class MigrationError extends Error {
  constructor(category, tag = "preflight") {
    super(category);
    this.category = category;
    this.tag = tag;
  }
}

export function safeFailure(error, tag = "preflight") {
  let category = "unclassified";
  if (error instanceof MigrationError) {
    category = error.category;
    tag = error.tag;
  } else {
    // Drizzle wraps driver errors; never print messages, queries, parameters or causes.
    const code = error?.cause?.code ?? error?.code;
    if (
      [
        "CERT_HAS_EXPIRED",
        "CERT_NOT_YET_VALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_GET_ISSUER_CERT",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      ].includes(code)
    )
      category = "tls_certificate";
    else if (["28000", "28P01"].includes(code)) category = "authentication";
    else if (
      [
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ECONNRESET",
        "CONNECT_TIMEOUT",
      ].includes(code)
    )
      category = "connection";
    else if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) category = "database";
  }
  return new MigrationError(category, tag);
}

export function assertApproval(env, head) {
  const sha = env.GITHUB_SHA;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    env.GITHUB_REPOSITORY !== "OMERTA-ROW/jackboy-dev-control" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.RUNNER_ENVIRONMENT !== "staging" ||
    env.GITHUB_WORKFLOW_REF !==
      "OMERTA-ROW/jackboy-dev-control/.github/workflows/staging-bounded-migrate.yml@refs/heads/main" ||
    !/^[0-9a-f]{40}$/.test(sha ?? "") ||
    env.GITHUB_WORKFLOW_SHA !== sha ||
    env.APPROVED_COMMIT !== sha ||
    head !== sha ||
    env.STAGING_CONFIRMATION !== "railway-jackboy-staging"
  )
    throw new MigrationError("approval_input");
}

export function strictConnectionOptions(raw, encodedCa) {
  let url, username, password, ca;
  try {
    url = new URL(raw);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new MigrationError("invalid_connection_config");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !username ||
    !password ||
    url.search ||
    url.hash ||
    url.hostname !== target.host ||
    url.port !== String(target.port) ||
    url.pathname !== `/${target.database}`
  )
    throw new MigrationError("target_mismatch");
  if (
    typeof encodedCa !== "string" ||
    !encodedCa.length ||
    encodedCa.length > 32768 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedCa)
  )
    throw new MigrationError("invalid_ca_certificate");
  try {
    const bytes = Buffer.from(encodedCa, "base64");
    if (bytes.toString("base64") !== encodedCa) throw new Error();
    ca = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      !/^\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(ca)
    )
      throw new Error();
    new X509Certificate(ca);
  } catch {
    throw new MigrationError("invalid_ca_certificate");
  }
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    username,
    password,
    ssl: { ca, servername: target.host, rejectUnauthorized: true },
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    fetch_types: false,
    onnotice: false,
    debug: false,
    connection: { application_name: "jackboy-staging-bounded-migrate" },
  };
}

export async function loadPlan() {
  const journal = JSON.parse(await readFile("drizzle/migrations/meta/_journal.json", "utf8"));
  const entries = journal.entries.slice(0, 65);
  if (
    journal.dialect !== "postgresql" ||
    journal.version !== "7" ||
    entries.length !== 65 ||
    entries[64].tag !== cutoff ||
    entries[43].tag !== "0043_code_provider_gateway" ||
    entries.some(
      (entry, index) =>
        entry.idx !== index ||
        !new RegExp(`^${String(index).padStart(4, "0")}_[a-z0-9_]+$`).test(entry.tag) ||
        entry.version !== "7" ||
        entry.breakpoints !== true ||
        !Number.isSafeInteger(entry.when) ||
        (index > 0 && entry.when <= entries[index - 1].when),
    )
  )
    throw new MigrationError("migration_journal_mismatch");
  const files = await Promise.all(
    entries.map((entry) => readFile(`drizzle/migrations/${entry.tag}.sql`)),
  );
  const seedSql = files[54].toString("utf8");
  const seeds = [...seedSql.matchAll(/(?:SELECT|UNION ALL SELECT) '([a-z0-9-]+)',/g)].map(
    (match) => match[1],
  );
  if (JSON.stringify(seeds) !== JSON.stringify(seedSlugs)) {
    throw new MigrationError("seed_definition_mismatch");
  }
  return {
    journal: { ...journal, entries },
    files,
    history: entries.map((entry, index) => ({
      hash: createHash("sha256").update(files[index]).digest("hex"),
      created_at: String(entry.when),
    })),
  };
}

export function assertHistory(rows, expected) {
  if (
    rows.length !== expected.length ||
    rows.some(
      (row, index) =>
        row.hash !== expected[index].hash ||
        String(row.created_at) !== expected[index].created_at ||
        !Number.isSafeInteger(Number(row.id)) ||
        Number(row.id) <= 0 ||
        (index > 0 && Number(row.id) <= Number(rows[index - 1].id)),
    )
  )
    throw new MigrationError("migration_history_mismatch");
}

export async function assertIdentity(query) {
  const rows = await query(`
    SELECT current_database() AS database, environment_id::text, service_id::text
    FROM public.jackboy_staging_identity
  `);
  if (
    rows.length !== 1 ||
    rows[0].database !== target.database ||
    rows[0].environment_id !== target.environmentId ||
    rows[0].service_id !== target.serviceId
  )
    throw new MigrationError("staging_identity_mismatch");
}

export async function assertSeedAvailable(query) {
  const table = await query("SELECT to_regclass('public.chat_contexts') AS contexts");
  if (table.length !== 1) throw new MigrationError("seed_check_unavailable");
  if (table[0].contexts !== null) {
    const rows = await query("SELECT slug FROM public.chat_contexts WHERE slug = ANY($1::text[])", [
      seedSlugs,
    ]);
    if (rows.length) throw new MigrationError("seed_slug_conflict");
    // 0054 creates this table, so even an empty pre-existing table is schema drift.
    throw new MigrationError("seed_schema_conflict");
  }
}

export async function assertCodeStopped(query, withTotalLimit = true) {
  const rows = await query(`
    SELECT enabled, kill_switch, active_request_id, active_run_id,
      per_task_reserve_usd::text, daily_spend_limit_usd::text,
      ${withTotalLimit ? "total_spend_limit_usd::text," : ""}
      (SELECT paused FROM public.automation_policy WHERE id = 1) AS paused,
      NOT EXISTS (SELECT 1 FROM public.code_spend_reservations WHERE status = 'reserved') AS no_holds
    FROM public.code_runtime_controls WHERE singleton = true
  `);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.enabled !== false ||
    row.kill_switch !== true ||
    row.active_request_id !== null ||
    row.active_run_id !== null ||
    row.paused !== true ||
    row.no_holds !== true ||
    Number(row.per_task_reserve_usd) !== 1 ||
    Number(row.daily_spend_limit_usd) !== 5 ||
    (withTotalLimit && Number(row.total_spend_limit_usd) !== 10)
  )
    throw new MigrationError("code_not_stopped_or_holds");
}

const historyQuery =
  "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id";

export async function applyBounded(query, applyPrefix, plan) {
  let tag = "preflight";
  try {
    await query("SET LOCAL lock_timeout = '5s'");
    await query("SET LOCAL statement_timeout = '60s'");
    const lock = await query("SELECT pg_try_advisory_xact_lock(42202074998) AS acquired");
    if (lock.length !== 1 || lock[0].acquired !== true)
      throw new MigrationError("concurrent_migration");
    await query("LOCK TABLE public.jackboy_staging_identity IN SHARE MODE");
    await assertIdentity(query);
    await query("LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE");
    assertHistory(await query(historyQuery), plan.history.slice(0, 44));
    await query(
      "LOCK TABLE public.automation_policy, public.code_runtime_controls, public.code_spend_reservations IN EXCLUSIVE MODE",
    );
    await assertCodeStopped(query, false);
    for (let index = 44; index <= 64; index++) {
      tag = plan.journal.entries[index].tag;
      if (index === 54) await assertSeedAvailable(query);
      if (index === 61) await assertCodeStopped(query);
      await applyPrefix(index);
      assertHistory(await query(historyQuery), plan.history.slice(0, index + 1));
    }
    await assertIdentity(query);
    await assertCodeStopped(query);
  } catch (error) {
    const failure = safeFailure(error, tag);
    failure.tag = tag;
    throw failure;
  }
}

export async function runWithClient(client, plan) {
  const folder = await mkdtemp(join(tmpdir(), "jackboy-bounded-"));
  try {
    await mkdir(join(folder, "meta"));
    for (const [index, entry] of plan.journal.entries.entries()) {
      await writeFile(join(folder, `${entry.tag}.sql`), plan.files[index]);
    }
    // Postgres.js 4.0 supports nested begin() as savepoints. The normal Drizzle
    // migrator owns SQL splitting and journal inserts; only its folder is bounded.
    await client.begin(async (tx) => {
      const db = drizzle(tx, { logger: false });
      await applyBounded(
        (sql, params = []) => tx.unsafe(sql, params),
        async (index) => {
          await writeFile(
            join(folder, "meta", "_journal.json"),
            JSON.stringify({
              ...plan.journal,
              entries: plan.journal.entries.slice(0, index + 1),
            }),
          );
          await migrate(db, { migrationsFolder: folder });
        },
        plan,
      );
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function main() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  assertApproval(process.env, head);
  if (
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  ) {
    throw new MigrationError("dirty_checkout");
  }
  const plan = await loadPlan();
  const options = strictConnectionOptions(
    process.env.STAGING_DATABASE_URL,
    process.env.STAGING_DB_CA_CERT,
  );
  const client = postgres(options);
  try {
    await runWithClient(client, plan);
  } finally {
    await client.end({ timeout: 5 });
  }
  console.log(`${cutoff}: verified_65_row_history`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const failure = safeFailure(error);
    console.error(`${failure.tag}: ${failure.category}`);
    process.exitCode = 1;
  }
}
