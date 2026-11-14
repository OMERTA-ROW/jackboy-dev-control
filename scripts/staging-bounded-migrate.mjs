import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

export const target = Object.freeze({
  database: "railway",
  environmentId: "83515d1e-141f-4fd1-8dfb-50764a73a5db",
  serviceId: "f0c879d1-1934-4b5b-b4e6-728bc807d51d",
});
export const cutoff = "0064_omni_configuration_probe";
export const seedSlugs = Object.freeze(["omni", "jax", "razul", "iggy"]);
export const reviewedMigrationHashes = Object.freeze({
  "0044_omni_sessions": "0c5269f2fd44a3d5dbe001d7a66f8102deff3bc853bce236a60645793606b937",
  "0045_omni_dispatch_grants": "b5e92bc96aba0eb4f4d79de9bf39d7fffcbcb1af33edd25859e54cb47bfe4c6b",
  "0046_code_total_spend_guard": "89bafabba9456e9cbd2fbbae29721183e19bc54da7042fafeeb3e9ba9378361a",
  "0047_code_hard_cap_gate": "26f7f20e49a526049ae71c5f577ba22f89d124dd295e10dd15b2e121065fab4c",
  "0048_code_spend_meter_and_activation":
    "cf331c49f89cca4d7fb314572443b3715c4d2c4ad37a533214c7bbdcd9e1e526",
  "0049_task_mode": "5658833b579af9b8c3ab26358dd4edbc53d824816543f89dc14d0cc732ae7f00",
  "0050_reports_alerts_undo": "2c6d8d27860f9b367bdaf17879a8e7ff6ddc723d770731252974d1349a6bb7a7",
  "0051_omni_build_test_handoffs":
    "d6f53838b793399c11d569fb507d5225ff350cfb7e89727fed5823d8317d8c45",
  "0052_omni_handoff_authorization":
    "d2f999e279d6f059e7d9ca283726c8126dba82ad9dcd739218081276dd8f5962",
  "0053_audit_logs_append_only_attributed":
    "c05d11b8d9694096d489cdf76d2dc8347639acb1bc9aadc0ac8bc6d0e633538d",
  "0054_chat_threads_contexts_attachments":
    "cc21c101655d085c9668ae95ae79f8fb19286a278788569a9e4fb8a71adbca06",
  "0055_owner_omni_handoffs_jax_manifests":
    "b468b533f78f7a926ce84982c662a221e7528a32ae5061077babe19eaed76e64",
  "0056_owner_omni_jax_tighten_grants":
    "dbc85b86a00d109038a9a5b4c64faf4f6b37e6d9c74d2faee8b8f6e7d44964db",
  "0057_omni_authorization_expiry":
    "fadff300aff743b3f1a00f5d133fb5e4a8cdab5acc63489516b6534c6141922d",
  "0058_omni_link_approval_save":
    "d2d3c52f7815dabec1902fbade337a86a7c6bb58a07b803fed1dbf3703c0253e",
  "0059_sync_safety_guards": "b8b9c452658a6cd54da7cd8e4866274098b2dfbef7eb05239650ea676cd06fef",
  "0060_code_acceptance_guard_verification":
    "453f95f477865ad0a6d662bc81a87eba9590f894c6b177e904bc0ce7fe911d44",
  "0061_verify_0059_0060_install":
    "a104a54f80beaed3de6ef2566d1f0cc42e7807b76581c4b42fbb2d9f5641263f",
  "0062_omni_dispatch_v3": "3d9e882b8cec18835456220c126d08d489037a61a5cc5bdf1b218bc06af3a3bf",
  "0063_omni_handoff_v1": "30c0378cd5255a82bf6bc0dc206739662b573ec395850cace5cb739e88696bfa",
  "0064_omni_configuration_probe":
    "55b00b5441ac0c80a428702bdce0ebd24590b11c8ddab0315b9e6b57f24c8c82",
});

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

export function assertApproval(env, mode = "inspect") {
  if (mode === "apply") throw new MigrationError("apply_disabled_pending_revised_plan");
  const sha = env.RAILWAY_GIT_COMMIT_SHA;
  if (
    mode !== "inspect" ||
    env.RAILWAY_ENVIRONMENT_ID !== target.environmentId ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(env.RAILWAY_SERVICE_ID ?? "") ||
    env.RAILWAY_SERVICE_ID === target.serviceId ||
    env.RAILWAY_GIT_REPO_OWNER !== "OMERTA-ROW" ||
    env.RAILWAY_GIT_REPO_NAME !== "jackboy-dev-control" ||
    env.RAILWAY_GIT_BRANCH !== "main" ||
    !/^[0-9a-f]{40}$/.test(sha ?? "") ||
    env.STAGING_MIGRATOR_APPROVED_COMMIT !== sha
  )
    throw new MigrationError("approval_input");
}

export function modeFromEnv(env) {
  const mode = env.STAGING_MIGRATOR_MODE || "inspect";
  if (mode === "apply") throw new MigrationError("apply_disabled_pending_revised_plan");
  if (mode !== "inspect") throw new MigrationError("approval_input");
  return mode;
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
    !url.hostname.endsWith(".railway.internal") ||
    url.port !== "5432" ||
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
    host: url.hostname,
    port: 5432,
    database: target.database,
    username,
    password,
    ssl: { ca, servername: url.hostname, rejectUnauthorized: true },
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
  for (let index = 44; index <= 64; index++) {
    const entry = entries[index];
    if (
      createHash("sha256").update(files[index]).digest("hex") !== reviewedMigrationHashes[entry.tag]
    )
      throw new MigrationError("reviewed_file_mismatch", entry.tag);
  }
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

export async function inspectWithClient(client, plan) {
  let summary;
  await client.begin("isolation level repeatable read read only", async (tx) => {
    const query = (sql, params = []) => tx.unsafe(sql, params);
    await query("SET LOCAL statement_timeout = '15s'");
    await assertIdentity(query);
    const catalog = await readCatalogInventory(query);
    const diagnostics = {};
    for (const [name, check] of [
      [
        "history",
        async () => {
          const journal = await query(
            "SELECT to_regclass('drizzle.__drizzle_migrations') AS migration_table",
          );
          if (journal.length !== 1 || journal[0].migration_table === null)
            throw new MigrationError("migration_history_missing");
          assertHistory(await query(`${historyQuery} LIMIT 66`), plan.history.slice(0, 44));
        },
      ],
      ["seeds", () => assertSeedAvailable(query)],
      ["controls", () => assertCodeStopped(query, false)],
    ]) {
      await query("SAVEPOINT inspect_diagnostic");
      try {
        await check();
        diagnostics[name] = { status: "matched" };
      } catch (error) {
        const code = error?.cause?.code ?? error?.code;
        if (!(error instanceof MigrationError) && !["42P01", "42703"].includes(code)) throw error;
        await query("ROLLBACK TO SAVEPOINT inspect_diagnostic");
        diagnostics[name] = {
          status: "mismatch",
          category: error instanceof MigrationError ? error.category : "schema_check_unavailable",
        };
      }
      await query("RELEASE SAVEPOINT inspect_diagnostic");
    }
    summary = {
      mode: "inspect",
      target: "railway-staging",
      identity: "verified",
      diagnostics,
      catalog,
    };
  });
  return summary;
}

const catalogLimit = 200;
const columnLimit = 10_000;
const catalogQueries = Object.freeze({
  schemas: `
    /* staging-catalog:schemas */
    SELECT n.nspname AS schema_name
    FROM pg_namespace n
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    ORDER BY n.nspname COLLATE "C"
    LIMIT $1
  `,
  relations: `
    /* staging-catalog:relations */
    SELECT n.nspname AS schema_name, c.relname AS relation_name,
      CASE c.relkind
        WHEN 'r' THEN 'table'
        WHEN 'p' THEN 'partitioned_table'
        WHEN 'v' THEN 'view'
        WHEN 'm' THEN 'materialized_view'
        WHEN 'f' THEN 'foreign_table'
      END AS relation_kind,
      c.relrowsecurity AS row_security_enabled,
      c.relforcerowsecurity AS row_security_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
    LIMIT $1
  `,
  columns: `
    /* staging-catalog:columns */
    SELECT n.nspname AS schema_name, c.relname AS relation_name,
      a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", a.attnum
    LIMIT $1 OFFSET $2
  `,
  routines: `
    /* staging-catalog:routines */
    SELECT n.nspname AS schema_name, p.proname AS routine_name,
      CASE p.prokind
        WHEN 'f' THEN 'function'
        WHEN 'p' THEN 'procedure'
        WHEN 'a' THEN 'aggregate'
        WHEN 'w' THEN 'window'
      END AS routine_kind,
      pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_function_result(p.oid) AS result_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    ORDER BY n.nspname COLLATE "C", p.proname COLLATE "C",
      pg_get_function_identity_arguments(p.oid) COLLATE "C"
    LIMIT $1
  `,
  triggers: `
    /* staging-catalog:triggers */
    SELECT n.nspname AS schema_name, c.relname AS relation_name,
      t.tgname AS trigger_name, t.tgtype::integer AS trigger_type
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND NOT t.tgisinternal
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", t.tgname COLLATE "C"
    LIMIT $1
  `,
  policies: `
    /* staging-catalog:policies */
    SELECT n.nspname AS schema_name, c.relname AS relation_name,
      p.polname AS policy_name,
      CASE p.polcmd
        WHEN 'r' THEN 'select'
        WHEN 'a' THEN 'insert'
        WHEN 'w' THEN 'update'
        WHEN 'd' THEN 'delete'
        WHEN '*' THEN 'all'
      END AS command,
      p.polpermissive AS permissive,
      COALESCE((
        SELECT array_agg(
          CASE WHEN role_id = 0 THEN 'public' ELSE r.rolname::text END
          ORDER BY CASE WHEN role_id = 0 THEN 'public' ELSE r.rolname::text END
        )
        FROM unnest(p.polroles) AS role_ids(role_id)
        LEFT JOIN pg_roles r ON r.oid = role_id
      ), ARRAY[]::text[]) AS roles
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", p.polname COLLATE "C"
    LIMIT $1
  `,
});

function catalogIdentifier(value) {
  if (typeof value !== "string" || Array.from(value).length > 128 || /\p{Cc}/u.test(value))
    throw new MigrationError("catalog_metadata_invalid");
  return value;
}

function catalogType(value, maxLength = 512, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength ||
    !/^[A-Za-z0-9_.$"(),\[\]\s+-]*$/.test(value)
  )
    throw new MigrationError("catalog_metadata_invalid");
  return value;
}

function catalogBoolean(value) {
  if (typeof value !== "boolean") throw new MigrationError("catalog_metadata_invalid");
  return value;
}

function catalogRows(rows, limit) {
  if (!Array.isArray(rows)) throw new MigrationError("catalog_metadata_invalid");
  return rows.slice(0, limit);
}

function catalogSection(rows, map, keys, limit = catalogLimit) {
  const items = catalogRows(rows, limit).map(map);
  const keyOf = (item) => keys.map((key) => item[key]).join("\u0000");
  items.sort((left, right) => {
    const leftKey = keyOf(left);
    const rightKey = keyOf(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { items, truncated: rows.length > limit };
}

function catalogSectionFor(name, rows, map, keys, limit = catalogLimit) {
  try {
    return catalogSection(rows, map, keys, limit);
  } catch (error) {
    if (error instanceof MigrationError && error.category === "catalog_metadata_invalid") {
      const section = new Set([
        "schemas",
        "relations",
        "columns",
        "routines",
        "triggers",
        "policies",
      ]).has(name)
        ? name
        : "unknown";
      throw new MigrationError(`catalog_metadata_invalid:${section}`);
    }
    throw error;
  }
}

export async function readCatalogInventory(query) {
  const read = async (name) => {
    const rows = await query(catalogQueries[name], [catalogLimit + 1]);
    return rows;
  };
  const sections = {};
  sections.schemas = catalogSectionFor(
    "schemas",
    await read("schemas"),
    (row) => ({ name: catalogIdentifier(row.schema_name) }),
    ["name"],
  );
  sections.relations = catalogSectionFor(
    "relations",
    await read("relations"),
    (row) => {
      if (
        !["table", "partitioned_table", "view", "materialized_view", "foreign_table"].includes(
          row.relation_kind,
        )
      )
        throw new MigrationError("catalog_metadata_invalid");
      return {
        schema: catalogIdentifier(row.schema_name),
        name: catalogIdentifier(row.relation_name),
        kind: row.relation_kind,
        rowSecurityEnabled: catalogBoolean(row.row_security_enabled),
        rowSecurityForced: catalogBoolean(row.row_security_forced),
      };
    },
    ["schema", "name"],
  );
  const columns = [];
  for (let offset = 0; offset <= columnLimit; offset += catalogLimit) {
    const page = await query(catalogQueries.columns, [catalogLimit, offset]);
    if (!Array.isArray(page) || page.length > catalogLimit)
      throw new MigrationError("catalog_metadata_invalid:columns");
    if (columns.length + page.length > columnLimit)
      throw new MigrationError("catalog_column_limit_exceeded");
    columns.push(...page);
    if (page.length < catalogLimit) break;
  }
  sections.columns = catalogSectionFor(
    "columns",
    columns,
    (row) => ({
      schema: catalogIdentifier(row.schema_name),
      table: catalogIdentifier(row.relation_name),
      name: catalogIdentifier(row.column_name),
      type: catalogType(row.data_type),
      nullable: !catalogBoolean(row.not_null),
    }),
    ["schema", "table", "name"],
    columnLimit,
  );
  sections.routines = catalogSectionFor(
    "routines",
    await read("routines"),
    (row) => {
      if (!["function", "procedure", "aggregate", "window"].includes(row.routine_kind))
        throw new MigrationError("catalog_metadata_invalid");
      return {
        schema: catalogIdentifier(row.schema_name),
        name: catalogIdentifier(row.routine_name),
        kind: row.routine_kind,
        signature: catalogType(row.arguments, 2048, true),
        returns: row.result_type === null ? null : catalogType(row.result_type),
      };
    },
    ["schema", "name", "signature"],
  );
  sections.triggers = catalogSectionFor(
    "triggers",
    await read("triggers"),
    (row) => {
      if (!Number.isSafeInteger(row.trigger_type) || row.trigger_type < 0 || row.trigger_type > 127)
        throw new MigrationError("catalog_metadata_invalid");
      const eventFlags = [
        [4, "insert"],
        [8, "delete"],
        [16, "update"],
        [32, "truncate"],
      ];
      const events = eventFlags
        .filter(([flag]) => (row.trigger_type & flag) !== 0)
        .map(([, event]) => event);
      if (!events.length) throw new MigrationError("catalog_metadata_invalid");
      return {
        schema: catalogIdentifier(row.schema_name),
        table: catalogIdentifier(row.relation_name),
        name: catalogIdentifier(row.trigger_name),
        timing: row.trigger_type & 64 ? "instead_of" : row.trigger_type & 2 ? "before" : "after",
        level: row.trigger_type & 1 ? "row" : "statement",
        events,
      };
    },
    ["schema", "table", "name"],
  );
  sections.policies = catalogSectionFor(
    "policies",
    await read("policies"),
    (row) => {
      if (!["select", "insert", "update", "delete", "all"].includes(row.command))
        throw new MigrationError("catalog_metadata_invalid");
      if (!Array.isArray(row.roles)) throw new MigrationError("catalog_metadata_invalid");
      return {
        schema: catalogIdentifier(row.schema_name),
        table: catalogIdentifier(row.relation_name),
        name: catalogIdentifier(row.policy_name),
        command: row.command,
        permissive: catalogBoolean(row.permissive),
        roles: row.roles.map(catalogIdentifier).sort(),
      };
    },
    ["schema", "table", "name"],
  );
  return { limitPerSection: catalogLimit, columnLimit, ...sections };
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

export async function applyBounded() {
  throw new MigrationError("apply_disabled_pending_revised_plan");
}

export async function runWithClient() {
  throw new MigrationError("apply_disabled_pending_revised_plan");
}

export async function runWithDeadline(client, operation, milliseconds) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void client.end({ timeout: 0 }).catch(() => {});
      reject(new MigrationError("execution_timeout"));
    }, milliseconds);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const mode = modeFromEnv(process.env);
  assertApproval(process.env, mode);
  const plan = await loadPlan();
  const options = strictConnectionOptions(
    process.env.RAILWAY_PRIVATE_DB_URL,
    process.env.RAILWAY_DB_CA_CERT,
  );
  const client = postgres({ ...options, max_lifetime: 0 });
  try {
    const summary = await runWithDeadline(client, () => inspectWithClient(client, plan), 20_000);
    console.log(JSON.stringify(summary));
  } finally {
    await client.end({ timeout: 5 });
  }
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
