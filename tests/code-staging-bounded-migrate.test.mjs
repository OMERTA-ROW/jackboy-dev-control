import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:tls";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import {
  target,
  cutoff,
  seedSlugs,
  loadPlan,
  reviewedMigrationHashes,
  strictConnectionOptions,
  assertApproval,
  modeFromEnv,
  assertHistory,
  assertIdentity,
  assertSeedAvailable,
  assertCodeStopped,
  safeFailure,
  applyBounded,
  readCatalogInventory,
  inspectWithClient,
  runWithClient,
  runWithDeadline,
} from "../scripts/staging-bounded-migrate.mjs";
import { copyBoundedMigrations } from "../scripts/staging-bounded-image.mjs";

const plan = await loadPlan();
const sha = "a".repeat(40);
const approved = {
  RAILWAY_ENVIRONMENT_ID: target.environmentId,
  RAILWAY_SERVICE_ID: "runner-service-id",
  RAILWAY_GIT_REPO_OWNER: "OMERTA-ROW",
  RAILWAY_GIT_REPO_NAME: "jackboy-dev-control",
  RAILWAY_GIT_BRANCH: "main",
  RAILWAY_GIT_COMMIT_SHA: sha,
  STAGING_MIGRATOR_APPROVED_COMMIT: sha,
};
const identity = {
  database: target.database,
  environment_id: target.environmentId,
  service_id: target.serviceId,
};
const stopped = {
  enabled: false,
  kill_switch: true,
  active_request_id: null,
  active_run_id: null,
  per_task_reserve_usd: "1.00",
  daily_spend_limit_usd: "5.00",
  total_spend_limit_usd: "10.00",
  paused: true,
  no_holds: true,
};
const sentinel = "synthetic-secret-sentinel";
const catalogMock = {
  schemas: [{ schema_name: "public" }, { schema_name: "drizzle" }],
  relations: [
    {
      schema_name: "public",
      relation_name: "profiles",
      relation_kind: "table",
      row_security_enabled: true,
      row_security_forced: false,
      definition: sentinel,
    },
    {
      schema_name: "public",
      relation_name: "profile_view",
      relation_kind: "view",
      row_security_enabled: false,
      row_security_forced: false,
    },
  ],
  columns: [
    {
      schema_name: "public",
      relation_name: "profiles",
      column_name: "id",
      data_type: "uuid",
      not_null: true,
    },
  ],
  routines: [
    {
      schema_name: "public",
      routine_name: "lookup_profile",
      routine_kind: "function",
      arguments: "uuid",
      result_type: "jsonb",
      definition: sentinel,
    },
  ],
  triggers: [
    {
      schema_name: "public",
      relation_name: "profiles",
      trigger_name: "profiles_audit",
      trigger_type: 7,
      definition: sentinel,
    },
  ],
  policies: [
    {
      schema_name: "public",
      relation_name: "profiles",
      policy_name: "profiles_read",
      command: "select",
      permissive: true,
      roles: ["authenticated"],
      qual: sentinel,
    },
  ],
};
const history = (count) =>
  plan.history.slice(0, count).map((row, index) => ({ id: index + 1, ...row }));
const host = "jackboy-staging-db.railway.internal";
const url = `postgresql://fixture:${sentinel}@${host}:5432/${target.database}`;

const certDir = await mkdtemp(join(tmpdir(), "bounded-tls-fixture-"));
after(() => rm(certDir, { recursive: true, force: true }));
for (const name of ["matching", "wrong"]) {
  const certificateHost = name === "matching" ? host : "not-the-approved-host.railway.internal";
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${certificateHost}`,
      "-addext",
      `subjectAltName=DNS:${certificateHost}`,
      "-keyout",
      join(certDir, `${name}.key`),
      "-out",
      join(certDir, `${name}.crt`),
    ],
    { stdio: "ignore" },
  );
}
const ca = await readFile(join(certDir, "matching.crt"), "utf8");
const encodedCa = Buffer.from(ca).toString("base64");

test("cutoff is exactly the byte/hash-preserving original 65-entry journal prefix", async () => {
  const original = JSON.parse(await readFile("drizzle/migrations/meta/_journal.json", "utf8"));
  assert.deepEqual(plan.journal.entries, original.entries.slice(0, 65));
  assert.equal(plan.journal.entries.at(-1).tag, cutoff);
  assert.equal(plan.history.length, 65);
  assert.deepEqual(seedSlugs, ["omni", "jax", "razul", "iggy"]);
  assert.ok(plan.journal.entries.every((entry) => entry.idx <= 64));
  assert.deepEqual(
    Object.keys(reviewedMigrationHashes),
    plan.journal.entries.slice(44).map((entry) => entry.tag),
  );
});

test("read-only is default and apply is disabled regardless of approval", () => {
  assert.equal(modeFromEnv({}), "inspect");
  assert.throws(
    () => modeFromEnv({ STAGING_MIGRATOR_MODE: "apply" }),
    /apply_disabled_pending_revised_plan/,
  );
  assert.throws(() => modeFromEnv({ STAGING_MIGRATOR_MODE: "anything-else" }), /approval_input/);
  assertApproval(approved);
  assert.throws(() => assertApproval(approved, "apply"), /apply_disabled_pending_revised_plan/);
  assert.throws(
    () =>
      assertApproval(
        {
          ...approved,
          STAGING_MIGRATOR_APPLY_CONFIRMATION: "apply-0064-staging-once",
        },
        "apply",
      ),
    /apply_disabled_pending_revised_plan/,
  );
  for (const key of Object.keys(approved).filter((key) => key !== "RAILWAY_SERVICE_ID")) {
    assert.throws(() => assertApproval({ ...approved, [key]: "incorrect" }), /approval_input/);
    assert.throws(() => assertApproval({ ...approved, [key]: undefined }), /approval_input/);
  }
  assert.throws(
    () =>
      assertApproval({
        ...approved,
        STAGING_MIGRATOR_APPROVED_COMMIT: "b".repeat(40),
      }),
    /approval_input/,
  );
  assert.throws(
    () =>
      assertApproval({
        ...approved,
        RAILWAY_SERVICE_ID: target.serviceId,
      }),
    /approval_input/,
  );
  assert.throws(
    () =>
      assertApproval({
        ...approved,
        RAILWAY_SERVICE_ID: "not a service id",
      }),
    /approval_input/,
  );
  assert.throws(
    () =>
      assertApproval(
        {
          ...approved,
          STAGING_MIGRATOR_APPLY_CONFIRMATION: "wrong",
        },
        "apply",
      ),
    /apply_disabled_pending_revised_plan/,
  );
});

test("unapproved CLI exits before configuration/access and never prints synthetic credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/staging-bounded-migrate.mjs"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...approved,
      STAGING_MIGRATOR_APPROVED_COMMIT: "b".repeat(40),
      RAILWAY_PRIVATE_DB_URL: sentinel,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^preflight: approval_input/m);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
});

test("apply CLI rejects before connection configuration even with the former confirmation", () => {
  const result = spawnSync(process.execPath, ["scripts/staging-bounded-migrate.mjs"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...approved,
      STAGING_MIGRATOR_MODE: "apply",
      STAGING_MIGRATOR_APPLY_CONFIRMATION: "apply-0064-staging-once",
      RAILWAY_PRIVATE_DB_URL: sentinel,
      RAILWAY_DB_CA_CERT: sentinel,
    },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "preflight: apply_disabled_pending_revised_plan");
});

test("connection accepts only a private Railway URL and explicit CA/hostname verification", () => {
  const options = strictConnectionOptions(url, encodedCa);
  assert.deepEqual(options.ssl, { ca, servername: host, rejectUnauthorized: true });
  assert.equal(options.onnotice, false);
  assert.equal(options.debug, false);
  assert.equal(options.prepare, false);
  for (const invalid of [
    url.replace(host, "shinkansen.proxy.rlwy.net"),
    url.replace(host, "other.example.test"),
    url.replace("5432", "48734"),
    url.replace("/railway", "/production"),
    `${url}?sslmode=require`,
    `${url}#fragment`,
    url.replace(`${sentinel}@`, "@"),
    "not-a-url",
  ])
    assert.throws(() => strictConnectionOptions(invalid, encodedCa));
  for (const invalid of [
    undefined,
    "",
    "not-base64",
    encodedCa + "\n",
    Buffer.from(ca + ca).toString("base64"),
  ]) {
    assert.throws(() => strictConnectionOptions(url, invalid), /invalid_ca_certificate/);
  }
});

async function localTls(name, trustedCa) {
  const server = createServer(
    {
      key: await readFile(join(certDir, `${name}.key`)),
      cert: await readFile(join(certDir, `${name}.crt`)),
    },
    (socket) => socket.end(),
  );
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const ssl = strictConnectionOptions(url, Buffer.from(trustedCa).toString("base64")).ssl;
    await new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: server.address().port, ...ssl });
      socket.once("error", reject);
      socket.once("secureConnect", () => {
        socket.end();
        resolve();
      });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("local synthetic TLS validates both CA and hostname without database connections", async () => {
  await localTls("matching", ca);
  await assert.rejects(
    localTls("wrong", ca),
    (error) => safeFailure(error).category === "tls_certificate",
  );
  const wrongCa = await readFile(join(certDir, "wrong.crt"), "utf8");
  await assert.rejects(localTls("wrong", wrongCa), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
});

test("live identity must be one exact database/environment/service marker", async () => {
  await assertIdentity(async () => [identity]);
  for (const rows of [
    [],
    [identity, identity],
    ...Object.keys(identity).map((key) => [{ ...identity, [key]: "wrong" }]),
  ])
    await assert.rejects(
      assertIdentity(async () => rows),
      /staging_identity_mismatch/,
    );
});

test("history refuses missing, extra, later, reordered, changed hashes/timestamps and bad IDs", () => {
  const expected = plan.history.slice(0, 44);
  assertHistory(history(44), expected);
  for (const rows of [
    history(43),
    history(45),
    history(65),
    history(44).reverse(),
    history(44).map((row, i) => (i === 43 ? { ...row, hash: "changed" } : row)),
    history(44).map((row, i) => (i === 43 ? { ...row, created_at: "0" } : row)),
    history(44).map((row, i) => (i === 43 ? { ...row, id: 1 } : row)),
  ])
    assert.throws(() => assertHistory(rows, expected), /migration_history_mismatch/);
});

test("0054 checks exact seeded slugs and refuses any existing table or unavailable check", async () => {
  await assertSeedAvailable(async () => [{ contexts: null }]);
  for (const slug of seedSlugs) {
    const queries = [];
    await assert.rejects(
      assertSeedAvailable(async (sql, params) => {
        queries.push({ sql, params });
        return params ? [{ slug }] : [{ contexts: "chat_contexts" }];
      }),
      /seed_slug_conflict/,
    );
    assert.deepEqual(queries[1].params, [seedSlugs]);
  }
  await assert.rejects(
    assertSeedAvailable(async (sql, params) => (params ? [] : [{ contexts: "chat_contexts" }])),
    /seed_schema_conflict/,
  );
  await assert.rejects(
    assertSeedAvailable(async () => []),
    /seed_check_unavailable/,
  );
  await assert.rejects(
    assertSeedAvailable(async () => {
      throw new Error(sentinel);
    }),
  );
});

test("0061 actual stopped controls, exact limits and zero reserved holds fail closed", async () => {
  await assertCodeStopped(async () => [stopped]);
  for (const [key, value] of [
    ["enabled", true],
    ["kill_switch", false],
    ["active_request_id", "active"],
    ["active_run_id", 1],
    ["paused", false],
    ["no_holds", false],
    ["per_task_reserve_usd", "2"],
    ["daily_spend_limit_usd", "4"],
    ["total_spend_limit_usd", "9"],
  ])
    await assert.rejects(
      assertCodeStopped(async () => [{ ...stopped, [key]: value }]),
      /code_not_stopped_or_holds/,
    );
  for (const key of Object.keys(stopped)) {
    const row = { ...stopped };
    delete row[key];
    await assert.rejects(
      assertCodeStopped(async () => [row]),
      /code_not_stopped_or_holds/,
    );
  }
  await assert.rejects(
    assertCodeStopped(async () => []),
    /code_not_stopped_or_holds/,
  );
  await assert.rejects(
    assertCodeStopped(async () => {
      throw new Error(sentinel);
    }),
  );
  await assertCodeStopped(async (sql) => {
    assert.doesNotMatch(sql, /total_spend_limit_usd/);
    const { total_spend_limit_usd, ...initial } = stopped;
    return [initial];
  }, false);
});

test("errors expose only trusted tags/categories, including wrapped TLS and DB errors", () => {
  for (const [code, category] of [
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_certificate"],
    ["28P01", "authentication"],
    ["ECONNRESET", "connection"],
    ["23505", "database"],
    [sentinel, "unclassified"],
  ]) {
    const failure = safeFailure(
      { cause: { code, message: url, detail: sentinel }, query: url, params: [sentinel] },
      cutoff,
    );
    assert.equal(failure.category, category);
    assert.equal(failure.tag, cutoff);
    assert.doesNotMatch(JSON.stringify(failure) + failure.stack, new RegExp(sentinel));
  }
});

function fixture(overrides = {}) {
  let rows = history(44);
  const calls = [];
  let nested = 0;
  let committed = false;
  let activeTx = null;
  const beginModes = [];
  const tx = {
    async begin(work) {
      nested++;
      return work(tx);
    },
    async savepoint(work) {
      nested++;
      return work(tx);
    },
    async unsafe(sql, params = []) {
      calls.push(sql);
      if (overrides.failOn && sql.includes(overrides.failOn)) {
        throw Object.assign(new Error(sentinel), { code: "23505" });
      }
      const catalogName = sql.match(
        /staging-catalog:(schemas|relations|columns|routines|triggers|policies)/,
      )?.[1];
      if (catalogName) return overrides.catalog?.[catalogName] ?? catalogMock[catalogName];
      if (sql.includes("pg_try_advisory_xact_lock")) return [{ acquired: overrides.lock ?? true }];
      if (sql.includes("SELECT current_database()")) return overrides.identity ?? [identity];
      if (
        sql.startsWith(
          "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
        )
      )
        return overrides.history ?? rows;
      if (sql.includes("SELECT enabled, kill_switch")) return overrides.controls ?? [stopped];
      if (sql.includes("to_regclass('drizzle.__drizzle_migrations')"))
        return [{ migration_table: "drizzle.__drizzle_migrations" }];
      if (sql.startsWith("SELECT to_regclass")) return [{ contexts: overrides.contexts ?? null }];
      if (sql.startsWith("SELECT slug")) return [{ slug: "omni" }];
      if (/select id, hash, created_at from "drizzle"/.test(sql)) return rows.slice(-1);
      if (/insert into "drizzle"\."__drizzle_migrations"/.test(sql)) {
        rows.push({ id: rows.length + 1, hash: params[0], created_at: String(params[1]) });
      }
      // Real Drizzle statements reach this mocked transport but no SQL is executed.
      return [];
    },
  };
  const client = {
    options: { parsers: {}, serializers: {} },
    async unsafe(sql, params = []) {
      if (!activeTx) throw new Error("no_transaction");
      return activeTx.unsafe(sql, params);
    },
    async begin(modeOrWork, maybeWork) {
      if (typeof modeOrWork === "string") beginModes.push(modeOrWork);
      const work = typeof modeOrWork === "function" ? modeOrWork : maybeWork;
      if (activeTx) return activeTx.begin(work);
      const before = rows.slice();
      activeTx = tx;
      try {
        await work(tx);
        committed = true;
      } catch (error) {
        rows = before;
        throw error;
      } finally {
        activeTx = null;
      }
    },
  };
  return {
    client,
    query: tx.unsafe,
    calls,
    beginModes,
    get rows() {
      return rows;
    },
    get nested() {
      return nested;
    },
    get committed() {
      return committed;
    },
  };
}

test("disabled apply entrypoint cannot touch the client", async () => {
  const f = fixture();
  await assert.rejects(runWithClient(f.client, plan), /apply_disabled_pending_revised_plan/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.nested, 0);
  assert.equal(f.committed, false);
});

test("disabled apply helper never invokes the migration callback", async () => {
  for (const overrides of [
    { identity: [] },
    { history: history(45) },
    { lock: false },
    { controls: [{ ...stopped, enabled: true }] },
  ]) {
    const f = fixture(overrides);
    let applied = 0;
    await assert.rejects(
      applyBounded(
        f.query,
        async () => {
          applied++;
        },
        plan,
      ),
    );
    assert.equal(applied, 0);
  }
});

test("disabled apply never starts a transaction even with seed conflicts", async () => {
  const f = fixture({ contexts: "chat_contexts" });
  await assert.rejects(
    runWithClient(f.client, plan),
    (error) => error.category === "apply_disabled_pending_revised_plan",
  );
  assert.equal(f.nested, 0);
  assert.equal(f.committed, false);
  assert.equal(f.rows.length, 44);
});

test("safe inspection uses a read-only transaction and never invokes the migrator", async () => {
  const f = fixture();
  const summary = await inspectWithClient(f.client, plan);
  assert.deepEqual(summary, {
    mode: "inspect",
    target: "railway-staging",
    identity: "verified",
    diagnostics: {
      history: { status: "matched" },
      seeds: { status: "matched" },
      controls: { status: "matched" },
    },
    catalog: {
      limitPerSection: 200,
      columnLimit: 10_000,
      schemas: {
        items: [{ name: "drizzle" }, { name: "public" }],
        truncated: false,
      },
      relations: {
        items: [
          {
            schema: "public",
            name: "profile_view",
            kind: "view",
            rowSecurityEnabled: false,
            rowSecurityForced: false,
          },
          {
            schema: "public",
            name: "profiles",
            kind: "table",
            rowSecurityEnabled: true,
            rowSecurityForced: false,
          },
        ],
        truncated: false,
      },
      columns: {
        items: [
          {
            schema: "public",
            table: "profiles",
            name: "id",
            type: "uuid",
            nullable: false,
          },
        ],
        truncated: false,
      },
      routines: {
        items: [
          {
            schema: "public",
            name: "lookup_profile",
            kind: "function",
            signature: "uuid",
            returns: "jsonb",
          },
        ],
        truncated: false,
      },
      triggers: {
        items: [
          {
            schema: "public",
            table: "profiles",
            name: "profiles_audit",
            timing: "before",
            level: "row",
            events: ["insert"],
          },
        ],
        truncated: false,
      },
      policies: {
        items: [
          {
            schema: "public",
            table: "profiles",
            name: "profiles_read",
            command: "select",
            permissive: true,
            roles: ["authenticated"],
          },
        ],
        truncated: false,
      },
    },
  });
  assert.deepEqual(f.beginModes, ["isolation level repeatable read read only"]);
  assert.equal(f.nested, 0);
  assert.equal(f.rows.length, 44);
  assert.equal(f.committed, true);
});

test("catalog inventory is bounded, sorted, projected and excludes definitions or expressions", async () => {
  const queries = [];
  const inventory = await readCatalogInventory(async (sql, params) => {
    queries.push({ sql, params });
    const name = sql.match(
      /staging-catalog:(schemas|relations|columns|routines|triggers|policies)/,
    )?.[1];
    return catalogMock[name];
  });
  assert.equal(inventory.limitPerSection, 200);
  assert.deepEqual(
    inventory.schemas.items.map((row) => row.name),
    ["drizzle", "public"],
  );
  assert.deepEqual(
    inventory.relations.items.map((row) => row.name),
    ["profile_view", "profiles"],
  );
  assert.deepEqual(inventory.routines.items[0], {
    schema: "public",
    name: "lookup_profile",
    kind: "function",
    signature: "uuid",
    returns: "jsonb",
  });
  assert.deepEqual(inventory.triggers.items[0].events, ["insert"]);
  assert.deepEqual(inventory.policies.items[0].roles, ["authenticated"]);
  assert.doesNotMatch(JSON.stringify(inventory), new RegExp(sentinel));
  assert.equal(queries.length, 6);
  for (const { sql, params } of queries) {
    assert.deepEqual(params, sql.includes("staging-catalog:columns") ? [200, 0] : [201]);
    assert.match(sql, /ORDER BY/);
    assert.match(sql, /LIMIT \$1/);
    assert.doesNotMatch(
      sql,
      /pg_get_viewdef|pg_get_functiondef|pg_get_expr|prosrc|polqual|polwithcheck/,
    );
  }
});

test("column pagination emits all columns beyond 200 and fails closed at its ceiling", async () => {
  const rows = Array.from({ length: 10_001 }, (_, index) => ({
    schema_name: "public",
    relation_name: "fixture",
    column_name: `column_${String(index).padStart(5, "0")}`,
    data_type: "text",
    not_null: false,
    row_data: sentinel,
  }));
  for (const count of [201, 400, 10_000, 10_001]) {
    const offsets = [];
    const result = readCatalogInventory(async (sql, params) => {
      if (sql.includes("staging-catalog:columns")) {
        const [limit, offset] = params;
        assert.equal(limit, 200);
        offsets.push(offset);
        return rows.slice(0, count).slice(offset, offset + limit);
      }
      const section = sql.match(/staging-catalog:(\w+)/)[1];
      return catalogMock[section];
    });
    if (count > 10_000) {
      await assert.rejects(result, /catalog_column_limit_exceeded/);
    } else {
      const inventory = await result;
      assert.equal(inventory.columns.items.length, count);
      assert.equal(inventory.columns.truncated, false);
      assert.deepEqual(
        inventory.columns.items.map((row) => row.name),
        rows.slice(0, count).map((row) => row.column_name),
      );
      assert.doesNotMatch(JSON.stringify(inventory), new RegExp(sentinel));
    }
    assert.ok(offsets.length <= 51);
    assert.deepEqual(
      offsets,
      offsets.map((_, index) => index * 200),
    );
  }
});

test("real catalog pagination includes columns after the first page in a read-only snapshot", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE TABLE public.wide_fixture (${Array.from(
        { length: 225 },
        (_, index) => `column_${index} text`,
      ).join(", ")})`,
    );
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const inventory = await readCatalogInventory(
      async (sql, params) => (await db.query(sql, params)).rows,
    );
    await db.exec("COMMIT");
    const columns = inventory.columns.items.filter((row) => row.table === "wide_fixture");
    assert.equal(columns.length, 225);
    assert.ok(columns.some((row) => row.name === "column_224"));
    assert.equal(inventory.columns.truncated, false);
  } finally {
    await db.close();
  }
});

test("inspection reports drift separately while preserving catalog output", async () => {
  const f = fixture({
    history: history(45),
    contexts: "chat_contexts",
    controls: [{ ...stopped, enabled: true }],
  });
  const result = await inspectWithClient(f.client, plan);
  assert.deepEqual(result.diagnostics, {
    history: { status: "mismatch", category: "migration_history_mismatch" },
    seeds: { status: "mismatch", category: "seed_slug_conflict" },
    controls: { status: "mismatch", category: "code_not_stopped_or_holds" },
  });
  assert.equal(result.catalog.schemas.items.length, 2);
  assert.deepEqual(f.beginModes, ["isolation level repeatable read read only"]);
});

test("inspection never masks identity, TLS, or unexpected diagnostic errors", async () => {
  const f = fixture({ identity: [] });
  await assert.rejects(inspectWithClient(f.client, plan), /staging_identity_mismatch/);
  assert.ok(f.calls.every((sql) => !sql.includes("staging-catalog")));
  for (const code of ["ERR_TLS_CERT_ALTNAME_INVALID", "ECONNRESET", "42501"]) {
    const g = fixture();
    const original = g.client.begin;
    g.client.begin = (mode, work) =>
      original(mode, (tx) =>
        work({
          unsafe: (sql, params) => {
            if (sql.includes("to_regclass")) throw Object.assign(new Error(sentinel), { code });
            return tx.unsafe(sql, params);
          },
        }),
      );
    await assert.rejects(inspectWithClient(g.client, plan), (error) => error.code === code);
  }
});

test("missing diagnostic schema rolls back savepoints and still returns inventory in PGlite", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE public.jackboy_staging_identity (
        environment_id text, service_id text
      );
      INSERT INTO public.jackboy_staging_identity VALUES (
        '${target.environmentId}', '${target.serviceId}'
      );
    `);
    const result = await inspectWithClient(
      {
        begin: async (mode, work) => {
          assert.equal(mode, "isolation level repeatable read read only");
          await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          try {
            await work({
              unsafe: async (sql, params = []) => {
                const rows = (await db.query(sql, params)).rows;
                if (sql.includes("SELECT current_database()"))
                  return rows.map((row) => ({ ...row, database: target.database }));
                return rows;
              },
            });
            await db.exec("COMMIT");
          } catch (error) {
            await db.exec("ROLLBACK");
            throw error;
          }
        },
      },
      plan,
    );
    assert.equal(result.diagnostics.history.category, "migration_history_missing");
    assert.equal(result.diagnostics.controls.category, "schema_check_unavailable");
    assert.ok(
      result.catalog.relations.items.some((row) => row.name === "jackboy_staging_identity"),
    );
  } finally {
    await db.close();
  }
});

test("catalog sections report truncation and reject unsafe metadata without echoing it", async () => {
  const inventory = await readCatalogInventory(async (sql) => {
    const section = sql.match(
      /staging-catalog:(schemas|relations|columns|routines|triggers|policies)/,
    )?.[1];
    if (section !== "schemas") return catalogMock[section];
    return Array.from({ length: 201 }, (_, index) => ({ schema_name: `schema_${index}` }));
  });
  assert.equal(inventory.schemas.items.length, 200);
  assert.equal(inventory.schemas.truncated, true);
  await assert.rejects(
    readCatalogInventory(async (sql) => {
      const section = sql.match(
        /staging-catalog:(schemas|relations|columns|routines|triggers|policies)/,
      )?.[1];
      return section === "schemas"
        ? [{ schema_name: `${sentinel}\ninvalid` }]
        : catalogMock[section];
    }),
    (error) => {
      assert.equal(error.category, "catalog_metadata_invalid:schemas");
      assert.doesNotMatch(error.stack, new RegExp(sentinel));
      return true;
    },
  );
});

test("catalog accepts printable names with spaces and hyphens and emits JSON-escaped output", async () => {
  const policyNames = ["owner read-policy", 'owner "review"-policy'];
  const inventory = await readCatalogInventory(async (sql) => {
    const section = sql.match(
      /staging-catalog:(schemas|relations|columns|routines|triggers|policies)/,
    )?.[1];
    if (section !== "policies") return catalogMock[section];
    return policyNames.map((policy_name) => ({
      schema_name: "public",
      relation_name: "profiles",
      policy_name,
      command: "select",
      permissive: true,
      roles: ["authenticated"],
    }));
  });
  const json = JSON.stringify(inventory);
  assert.deepEqual(
    JSON.parse(json).policies.items.map((row) => row.name),
    [...policyNames].sort(),
  );
  assert.match(json, /owner \\"review\\"-policy/);
});

test("catalog validation errors name only the allowlisted section and never row values", async () => {
  const privateValue = "private-policy-name";
  await assert.rejects(
    readCatalogInventory(async (sql) => {
      const section = sql.match(
        /staging-catalog:(schemas|relations|columns|routines|triggers|policies)/,
      )?.[1];
      if (section !== "policies") return catalogMock[section];
      return [
        {
          ...catalogMock.policies[0],
          policy_name: `${privateValue}\ninvalid`,
        },
      ];
    }),
    (error) => {
      assert.equal(error.category, "catalog_metadata_invalid:policies");
      assert.doesNotMatch(error.stack, new RegExp(privateValue));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(privateValue));
      return true;
    },
  );
});

test("catalog inventory queries inspect only metadata in an in-memory PostgreSQL fixture", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA fixture;
      CREATE TABLE fixture.sample (id uuid NOT NULL, label text);
      INSERT INTO fixture.sample VALUES ('00000000-0000-0000-0000-000000000001', '${sentinel}');
      CREATE VIEW fixture.sample_view AS SELECT id, label FROM fixture.sample;
      CREATE FUNCTION fixture.lookup_profile(uuid) RETURNS jsonb
        LANGUAGE sql AS 'SELECT ''{}''::jsonb';
      CREATE FUNCTION fixture.secret_marker() RETURNS text
        LANGUAGE sql AS 'SELECT ''${sentinel}''';
      CREATE FUNCTION fixture.noop_trigger() RETURNS trigger
        LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
      CREATE TRIGGER sample_audit BEFORE INSERT ON fixture.sample
        FOR EACH ROW EXECUTE FUNCTION fixture.noop_trigger();
      CREATE POLICY sample_read ON fixture.sample FOR SELECT TO PUBLIC
        USING (label = '${sentinel}');
      ALTER TABLE fixture.sample ENABLE ROW LEVEL SECURITY;
    `);
    const inventory = await readCatalogInventory(async (sql, params = []) => {
      return (await db.query(sql, params)).rows;
    });
    assert.ok(inventory.schemas.items.some((row) => row.name === "fixture"));
    assert.ok(
      inventory.relations.items.some(
        (row) => row.schema === "fixture" && row.name === "sample_view" && row.kind === "view",
      ),
    );
    assert.ok(
      inventory.columns.items.some(
        (row) =>
          row.schema === "fixture" &&
          row.table === "sample" &&
          row.name === "id" &&
          row.type === "uuid" &&
          !row.nullable,
      ),
    );
    assert.ok(
      inventory.routines.items.some(
        (row) =>
          row.schema === "fixture" &&
          row.name === "lookup_profile" &&
          row.signature === "uuid" &&
          row.returns === "jsonb",
      ),
    );
    assert.ok(
      inventory.triggers.items.some(
        (row) =>
          row.schema === "fixture" && row.name === "sample_audit" && row.events.includes("insert"),
      ),
    );
    assert.ok(
      inventory.relations.items.some(
        (row) =>
          row.schema === "fixture" &&
          row.name === "sample" &&
          row.rowSecurityEnabled &&
          !row.rowSecurityForced,
      ),
    );
    assert.ok(
      inventory.policies.items.some(
        (row) =>
          row.schema === "fixture" &&
          row.name === "sample_read" &&
          row.command === "select" &&
          row.roles.includes("public"),
      ),
    );
    assert.doesNotMatch(JSON.stringify(inventory), new RegExp(sentinel));
  } finally {
    await db.close();
  }
});

test("disabled apply never advances the migration plan", async () => {
  const f = fixture();
  let applied = 0;
  const query = async (sql, params) => {
    if (sql.includes("SELECT enabled, kill_switch") && applied === 17)
      return [{ ...stopped, no_holds: false }];
    return f.query(sql, params);
  };
  await assert.rejects(
    applyBounded(
      query,
      async (index) => {
        applied++;
        // Advance only the mock history; no migration is executed.
        f.rows.push({ id: index + 1, ...plan.history[index] });
      },
      plan,
    ),
    (error) => error.category === "apply_disabled_pending_revised_plan",
  );
  assert.equal(applied, 0);
});

test("disabled apply never reaches migration SQL or leaks driver details", async () => {
  const f = fixture({ failOn: "CREATE TABLE public.chat_threads" });
  await assert.rejects(runWithClient(f.client, plan), (error) => {
    assert.equal(error.tag, "preflight");
    assert.equal(error.category, "apply_disabled_pending_revised_plan");
    assert.doesNotMatch(error.stack, new RegExp(sentinel));
    return true;
  });
  assert.equal(f.nested, 0);
  assert.equal(f.rows.length, 44);
  assert.equal(f.committed, false);
  assert.equal(f.calls.length, 0);
});

test("image builder copies only journal entries through fixed 0064", async () => {
  const output = await mkdtemp(join(tmpdir(), "bounded-image-test-"));
  try {
    const count = await copyBoundedMigrations("drizzle/migrations", output);
    assert.equal(count, 65);
    const journal = JSON.parse(await readFile(join(output, "meta", "_journal.json"), "utf8"));
    assert.equal(journal.entries.length, 65);
    assert.equal(journal.entries.at(-1).tag, cutoff);
    assert.equal(
      await readFile(join(output, `${cutoff}.sql`), "utf8"),
      await readFile(`drizzle/migrations/${cutoff}.sql`, "utf8"),
    );
    await assert.rejects(readFile(join(output, "0065_code_independent_controls.sql")));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("the actual Drizzle migrator preserves standard hashes in local PGlite", async () => {
  const folder = await mkdtemp(join(tmpdir(), "bounded-pglite-migration-"));
  const client = new PGlite();
  try {
    await mkdir(join(folder, "meta"), { recursive: true });
    const entries = [
      { idx: 0, version: "7", when: 1, tag: "0000_first", breakpoints: true },
      { idx: 1, version: "7", when: 2, tag: "0001_second", breakpoints: true },
    ];
    await writeFile(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries }),
    );
    await writeFile(
      join(folder, "0000_first.sql"),
      "CREATE TABLE migration_probe (value integer PRIMARY KEY);",
    );
    await writeFile(
      join(folder, "0001_second.sql"),
      "INSERT INTO migration_probe (value) VALUES (64);",
    );
    const db = drizzlePglite(client, { logger: false });
    await client.waitReady;
    await migratePglite(db, { migrationsFolder: folder });
    const rows = await client.query("SELECT value FROM migration_probe");
    assert.equal(rows.rows[0].value, 64);
    const journalRows = await client.query(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
    );
    assert.equal(journalRows.rows.length, 2);
    assert.equal(String(journalRows.rows[0].created_at), "1");
    assert.equal(String(journalRows.rows[1].created_at), "2");
  } finally {
    await client.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("hard execution deadline tears down the connection", async () => {
  let closed = false;
  await assert.rejects(
    runWithDeadline(
      {
        async end(options) {
          closed = options.timeout === 0;
        },
      },
      () => new Promise(() => {}),
      5,
    ),
    /execution_timeout/,
  );
  assert.equal(closed, true);
});

test("image CI builds only and cannot start the inspector or deploy", async () => {
  const workflow = await readFile(".github/workflows/staging-inspector-image.yml", "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  const commands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(commands, [
    "docker build --file staging/bounded-migrator/Dockerfile --tag jackboy-staging-inspector:ci .",
  ]);
  assert.doesNotMatch(
    workflow,
    /secrets\.|environment:|workflow_dispatch:|docker run|docker push|railway up/,
  );
});

test("Railway container is private-network-only by default and never auto-restarts", async () => {
  const config = JSON.parse(await readFile("staging/bounded-migrator/railway.json", "utf8"));
  const dockerfile = await readFile("staging/bounded-migrator/Dockerfile", "utf8");
  await assert.rejects(readFile(".github/workflows/staging-bounded-migrate.yml"));
  assert.equal(config.deploy.restartPolicyType, "NEVER");
  assert.equal(config.deploy.numReplicas, 1);
  assert.equal(config.build.dockerfilePath, "staging/bounded-migrator/Dockerfile");
  assert.match(dockerfile, /STAGING_MIGRATOR_MODE=inspect/);
  assert.match(dockerfile, /ENTRYPOINT \["bun", "scripts\/staging-bounded-migrate\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /EXPOSE|node server|vite|start/);
  const runner = await readFile("scripts/staging-bounded-migrate.mjs", "utf8");
  assert.doesNotMatch(
    runner,
    /shinkansen\.proxy\.rlwy\.net|STAGING_DATABASE_URL|checkServerIdentity|rejectUnauthorized:\s*false|sslmode=require|staging-bounded-migrate\.yml/,
  );
});
