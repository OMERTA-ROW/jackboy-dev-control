import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:tls";
import {
  target,
  cutoff,
  seedSlugs,
  loadPlan,
  strictConnectionOptions,
  assertApproval,
  assertHistory,
  assertIdentity,
  assertSeedAvailable,
  assertCodeStopped,
  safeFailure,
  applyBounded,
  runWithClient,
} from "../scripts/staging-bounded-migrate.mjs";

const plan = await loadPlan();
const sha = "a".repeat(40);
const approved = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REPOSITORY: "OMERTA-ROW/jackboy-dev-control",
  GITHUB_REF: "refs/heads/main",
  RUNNER_ENVIRONMENT: "staging",
  GITHUB_WORKFLOW_REF:
    "OMERTA-ROW/jackboy-dev-control/.github/workflows/staging-bounded-migrate.yml@refs/heads/main",
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_SHA: sha,
  APPROVED_COMMIT: sha,
  STAGING_CONFIRMATION: "railway-jackboy-staging",
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
const history = (count) =>
  plan.history.slice(0, count).map((row, index) => ({ id: index + 1, ...row }));
const sentinel = "synthetic-secret-sentinel";
const url = `postgresql://fixture:${sentinel}@${target.host}:${target.port}/${target.database}`;

const certDir = await mkdtemp(join(tmpdir(), "bounded-tls-fixture-"));
after(() => rm(certDir, { recursive: true, force: true }));
for (const name of ["matching", "wrong"]) {
  const host = name === "matching" ? target.host : "not-the-approved-host.test";
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
      `/CN=${host}`,
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
});

test("approval binds manual first attempt, repository, main, environment, workflow and checkout SHA", () => {
  assertApproval(approved, sha);
  for (const key of Object.keys(approved)) {
    assert.throws(() => assertApproval({ ...approved, [key]: "incorrect" }, sha), /approval_input/);
    assert.throws(() => assertApproval({ ...approved, [key]: undefined }, sha), /approval_input/);
  }
  assert.throws(() => assertApproval(approved, "b".repeat(40)), /approval_input/);
});

test("unapproved CLI exits before configuration/access and never prints synthetic credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/staging-bounded-migrate.mjs"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...approved,
      APPROVED_COMMIT: "b".repeat(40),
      STAGING_DATABASE_URL: sentinel,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^preflight: approval_input/m);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
});

test("connection accepts only the fixed target and explicit CA/hostname verification", () => {
  const options = strictConnectionOptions(url, encodedCa);
  assert.deepEqual(options.ssl, { ca, servername: target.host, rejectUnauthorized: true });
  assert.equal(options.onnotice, false);
  assert.equal(options.debug, false);
  assert.equal(options.prepare, false);
  for (const invalid of [
    url.replace(target.host, "other.test"),
    url.replace(String(target.port), "48735"),
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
  const tx = {
    options: { parsers: {}, serializers: {} },
    async begin(work) {
      nested++;
      return work(tx);
    },
    async unsafe(sql, params = []) {
      calls.push(sql);
      if (overrides.failOn && sql.includes(overrides.failOn)) {
        throw Object.assign(new Error(sentinel), { code: "23505" });
      }
      if (sql.includes("pg_try_advisory_xact_lock")) return [{ acquired: overrides.lock ?? true }];
      if (sql.includes("SELECT current_database()")) return overrides.identity ?? [identity];
      if (
        sql ===
        "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id"
      )
        return overrides.history ?? rows;
      if (sql.includes("SELECT enabled, kill_switch")) return overrides.controls ?? [stopped];
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
    async begin(work) {
      const before = rows.slice();
      try {
        await work(tx);
        committed = true;
      } catch (error) {
        rows = before;
        throw error;
      }
    },
  };
  return {
    client,
    query: tx.unsafe,
    calls,
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

test("normal Drizzle runner emits 21 ordered entries with exact hashes and only 65 rows", async () => {
  const f = fixture();
  await runWithClient(f.client, plan);
  assert.equal(f.nested, 21);
  assert.equal(f.committed, true);
  assertHistory(f.rows, plan.history);
  assert.equal(f.rows.length, 65);
  assert.ok(f.calls.some((sql) => sql.includes("total_spend_limit_usd::text")));
  assert.ok(
    f.calls.every((sql) => !sql.includes("CREATE TABLE public.omni_autonomy_authorizations")),
  );
  assert.ok(
    f.calls.every((sql) => !sql.includes("CREATE OR REPLACE FUNCTION public.set_code_enabled")),
  );
});

test("preflight identity/history/concurrency/controls failures never call Drizzle", async () => {
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

test("0054 conflict stops before its SQL and rolls the whole mocked transaction back", async () => {
  const f = fixture({ contexts: "chat_contexts" });
  await assert.rejects(
    runWithClient(f.client, plan),
    (error) =>
      error.tag === plan.journal.entries[54].tag && error.category === "seed_slug_conflict",
  );
  assert.equal(f.nested, 10);
  assert.equal(f.committed, false);
  assert.equal(f.rows.length, 44);
});

test("0061 holds are rechecked immediately before migration; no resume or later SQL", async () => {
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
    (error) =>
      error.tag === plan.journal.entries[61].tag && error.category === "code_not_stopped_or_holds",
  );
  assert.equal(applied, 17);
});

test("first native migration error is secret-safe, rolled back and never retried", async () => {
  const f = fixture({ failOn: "CREATE TABLE public.chat_threads" });
  await assert.rejects(runWithClient(f.client, plan), (error) => {
    assert.equal(error.tag, plan.journal.entries[54].tag);
    assert.equal(error.category, "database");
    assert.doesNotMatch(error.stack, new RegExp(sentinel));
    return true;
  });
  assert.equal(f.nested, 11);
  assert.equal(f.rows.length, 44);
  assert.equal(f.committed, false);
  assert.equal(f.calls.filter((sql) => sql.includes("CREATE TABLE public.chat_threads")).length, 1);
});

test("workflow is manual, protected staging, read-only, non-canceling and has no cutoff input", async () => {
  const yaml = await readFile(".github/workflows/staging-bounded-migrate.yml", "utf8");
  assert.match(yaml, /on:\n  workflow_dispatch:/);
  assert.match(yaml, /permissions:\n  contents: read/);
  assert.match(yaml, /environment: staging/);
  assert.match(yaml, /group: staging-code-bootstrap\n  cancel-in-progress: false/);
  assert.match(yaml, /ref: main/);
  assert.match(yaml, /persist-credentials: false/);
  assert.doesNotMatch(
    yaml,
    /pull_request:|push:|schedule:|workflow_call:|cutoff:|migrationsFolder:/,
  );
  const runner = await readFile("scripts/staging-bounded-migrate.mjs", "utf8");
  assert.doesNotMatch(
    runner,
    /staging-db-preflight|staging-code-bootstrap|checkServerIdentity|rejectUnauthorized:\s*false|sslmode=require/,
  );
});
