// Real PostgreSQL engine (PGlite), real migration and handler. No Cloud/provider calls.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
const exec = promisify(execFile),
  root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({
  resolve(specifier, ctx, next) {
    if (specifier.startsWith("@/"))
      return next(pathToFileURL(resolve(root, "src", specifier.slice(2) + ".ts")).href, ctx);
    if (specifier.startsWith("./") && ctx.parentURL?.endsWith(".ts") && !specifier.endsWith(".ts"))
      return next(new URL(specifier + ".ts", ctx.parentURL).href, ctx);
    return next(specifier, ctx);
  },
});
const { handleOmniLink } = await import("../src/lib/omni-session.server.ts");
const { digest, requestMessage, LINK_PATH, LINK_CONTRACT } =
  await import("../src/lib/omni-session.ts");
const { hmacHex } = await import("../src/lib/omni-link.ts");
const { runProtocolSelfTest } = await import("../src/lib/omni-session-runner.server.ts");
const db = new PGlite();
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE owner_projects(id uuid primary key,created_by uuid,active boolean);
CREATE TABLE user_roles(user_id uuid,role text);
CREATE TABLE automation_policy(id int primary key,paused boolean);
CREATE TABLE omni_callback_nonces(nonce text primary key,received_at timestamptz default now());
CREATE TABLE site_log(id uuid default gen_random_uuid(),actor text,action text,category text,status text,summary text,project_id uuid,detail jsonb);
CREATE FUNCTION site_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only'; END $$;
CREATE TRIGGER site_log_no_change BEFORE UPDATE OR DELETE ON site_log FOR EACH ROW EXECUTE FUNCTION site_log_immutable();`);
await db.exec(await readFile(join(root, "drizzle/migrations/0030_omni_sessions.sql"), "utf8"));
await db.exec(
  await readFile(join(root, "drizzle/migrations/0064_omni_configuration_probe.sql"), "utf8"),
);
const project = "11111111-1111-4111-8111-111111111111",
  owner = "22222222-2222-4222-8222-222222222222",
  approval = "33333333-3333-4333-8333-333333333333";
const job = "44444444-4444-4444-8444-444444444444";
let config;
const store = async (op, args) =>
  (await db.query("SELECT omni_link_action($1,$2::jsonb) AS result", [op, JSON.stringify(args)]))
    .rows[0].result;
beforeEach(async () => {
  process.env["OMNI_LINK_NODE_RUNNER_ENABLED"] = "true";
  await db.exec(
    "TRUNCATE omni_link_sessions,omni_inbound_jobs,omni_callback_nonces,site_log,owner_projects,user_roles,automation_policy;",
  );
  await db.query("INSERT INTO owner_projects VALUES($1,$2,true)", [project, owner]);
  await db.query("INSERT INTO user_roles VALUES($1,'owner')", [owner]);
  await db.exec("INSERT INTO automation_policy VALUES(1,false)");
  config = {
    clientId: "omni-review",
    projectId: project,
    ownerId: owner,
    approvalId: approval,
    approvalExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    bootstrap: "b".repeat(64),
    secret: "s".repeat(64),
  };
});
after(() => db.close());
async function signed(action, token, extra = {}, options = {}) {
  const body = JSON.stringify({ action, projectId: project, ...extra }),
    nonce = options.nonce || crypto.randomUUID().replaceAll("-", ""),
    ts = options.ts || String(Math.floor(Date.now() / 1000));
  const signature = await hmacHex(
    config.secret,
    requestMessage(ts, nonce, await digest(token), body),
  );
  return new Request("https://jackboy.test" + LINK_PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "x-omni-client": config.clientId,
      "x-omni-nonce": nonce,
      "x-omni-timestamp": ts,
      "x-omni-signature": signature,
    },
    body,
  });
}
async function call(action, token, extra = {}, runner) {
  const req = await signed(action, token, extra);
  const res = await handleOmniLink(req, config, store, runner);
  const text = await res.text();
  if (res.ok)
    assert.equal(
      res.headers.get("x-omni-proof"),
      await hmacHex(
        config.secret,
        `${LINK_CONTRACT}\nresponse\n${req.headers.get("x-omni-nonce")}\n${res.status}\n${text}`,
      ),
    );
  return { status: res.status, ...JSON.parse(text) };
}
async function connect() {
  const r = await call("handshake", config.bootstrap);
  assert.equal(r.status, 200);
  return r.sessionToken;
}
test("authenticated handshake, hash-only session, scoped readiness and signed response", async () => {
  const r = await call("handshake", config.bootstrap);
  assert.equal(r.status, 200);
  assert.equal(r.ready, true);
  assert.deepEqual(r.capabilities, ["protocol.self-test", "jobs.read", "jobs.cancel"]);
  const rows = (await db.query("SELECT * FROM omni_link_sessions")).rows;
  assert.equal(rows[0].token_hash, await digest(r.sessionToken));
  assert(!JSON.stringify(rows).includes(r.sessionToken));
  assert(Date.parse(r.expiresAt) <= Date.now() + 300000);
});
test("disabled by default; HTTPS required; invalid credentials and stale signatures rejected", async () => {
  assert.equal(
    (await handleOmniLink(await signed("handshake", config.bootstrap), null, store)).status,
    503,
  );
  assert.equal((await call("handshake", "x".repeat(64))).status, 401);
  const req = await signed("handshake", config.bootstrap);
  req.headers.set("x-omni-signature", "0".repeat(64));
  assert.equal((await handleOmniLink(req, config, store)).status, 401);
  assert.equal(
    (
      await handleOmniLink(
        await signed("handshake", config.bootstrap, {}, { ts: "1790000000" }),
        config,
        store,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleOmniLink(
        new Request("http://jackboy.test" + LINK_PATH, { method: "POST" }),
        config,
        store,
      )
    ).status,
    400,
  );
});
test("replay rejected durably across handler instances and signed body tampering denied", async () => {
  const req = await signed("handshake", config.bootstrap),
    again = req.clone();
  assert.equal((await handleOmniLink(req, config, store)).status, 200);
  assert.equal((await handleOmniLink(again, config, store)).status, 409);
  const good = await signed("handshake", config.bootstrap);
  assert.equal(
    (
      await handleOmniLink(
        new Request(good.url, { method: "POST", headers: good.headers, body: "{}" }),
        config,
        store,
      )
    ).status,
    401,
  );
});
test("expired session rejected, reconnect recovers same queued job", async () => {
  const token = await connect();
  assert.equal(
    (await call("submit", token, { jobId: job, kind: "protocol.self-test" })).status,
    202,
  );
  await db.exec("UPDATE omni_link_sessions SET expires_at=now()-interval '1 second'");
  assert.equal((await call("status", token, { jobId: job })).status, 401);
  const fresh = await connect();
  assert.equal((await call("status", fresh, { jobId: job })).job.status, "queued");
});
test("cross-project, arbitrary CODE/shell jobs, unowned project, revocation and pause denied", async () => {
  const token = await connect();
  assert.equal((await call("submit", token, { jobId: job, kind: "code" })).status, 403);
  assert.equal(
    (await call("submit", token, { jobId: job, kind: "protocol.self-test", command: "sh" })).status,
    403,
  );
  assert.equal(
    (await call("submit", token, { jobId: job, kind: "protocol.self-test", projectId: owner }))
      .status,
    403,
  );
  await db.exec("UPDATE automation_policy SET paused=true");
  assert.equal((await call("status", token, { jobId: job })).status, 403);
  await db.exec(
    "UPDATE automation_policy SET paused=false; UPDATE owner_projects SET active=false",
  );
  assert.equal((await call("handshake", config.bootstrap)).status, 403);
  await db.exec("UPDATE owner_projects SET active=true; DELETE FROM user_roles");
  assert.equal((await call("handshake", config.bootstrap)).status, 403);
});
test("real restricted test job dispatch, execution and returned test evidence", async () => {
  const token = await connect();
  assert.equal(
    (await call("submit", token, { jobId: job, kind: "protocol.self-test" })).status,
    202,
  );
  const result = await call("run", token, { jobId: job });
  assert.equal(result.job.status, "completed");
  assert.equal(result.job.result.passed, true);
  assert.equal(result.job.result.checks, 3);
  const status = await call("status", token, { jobId: job });
  assert.deepEqual(status.job.result, result.job.result);
  assert.equal(
    (
      await call("run", token, { jobId: job }, () => {
        throw Error("must not rerun");
      })
    ).job.status,
    "completed",
  );
});
test("duplicates, two-job capacity and concurrent claims do not execute twice", async () => {
  const token = await connect();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      call("submit", token, { jobId: job, kind: "protocol.self-test" }),
    ),
  );
  assert.equal(results.filter((x) => x.status === 202).length, 1);
  const j2 = crypto.randomUUID();
  await call("submit", token, { jobId: j2, kind: "protocol.self-test" });
  assert.equal(
    (await call("submit", token, { jobId: crypto.randomUUID(), kind: "protocol.self-test" }))
      .status,
    429,
  );
  let runs = 0;
  const runner = async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 80));
    return true;
  };
  await Promise.all([
    call("run", token, { jobId: job }, runner),
    call("run", token, { jobId: job }, runner),
  ]);
  assert.equal(runs, 1);
});
test("timeout is terminal and status survives lost response; renewed grant cannot access old jobs", async () => {
  const token = await connect();
  await call("submit", token, { jobId: job, kind: "protocol.self-test" });
  await db.exec("UPDATE omni_inbound_jobs SET deadline=now()-interval '1 second'");
  assert.equal(
    (
      await call("run", token, { jobId: job }, () => {
        throw Error("must not execute");
      })
    ).job.status,
    "timed_out",
  );
  assert.equal(
    (await call("submit", token, { jobId: job, kind: "protocol.self-test" })).job.status,
    "timed_out",
  );
  config.approvalId = crypto.randomUUID();
  const fresh = await connect();
  assert.equal((await call("status", fresh, { jobId: job })).status, 404);
});
test("cancel queued/running jobs, abort process and never reopen terminal state", async () => {
  const token = await connect();
  await call("submit", token, { jobId: job, kind: "protocol.self-test" });
  let started;
  const ready = new Promise((r) => (started = r));
  let stopped = false;
  const running = call(
    "run",
    token,
    { jobId: job },
    (signal) =>
      new Promise((r) => {
        started();
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            r(false);
          },
          { once: true },
        );
      }),
  );
  await ready;
  assert.equal((await call("status", token, { jobId: job })).job.status, "running");
  assert.equal((await call("cancel", token, { jobId: job })).job.status, "cancelled");
  assert.equal((await running).job.status, "cancelled");
  assert(stopped);
  assert.equal((await call("run", token, { jobId: job })).job.status, "cancelled");
});
test("audits append-only, no keys/tokens in audit or jobs; DB outage fails closed", async () => {
  const token = await connect();
  await call("submit", token, { jobId: job, kind: "protocol.self-test" });
  await call("run", token, { jobId: job });
  const logs = (await db.query("SELECT * FROM site_log")).rows;
  assert(logs.some((x) => x.action === "omni.link.handshake"));
  assert(logs.some((x) => x.action === "omni.link.completed"));
  const text = JSON.stringify(logs);
  for (const secret of [token, config.bootstrap, config.secret]) assert(!text.includes(secret));
  await assert.rejects(db.exec("UPDATE site_log SET summary='changed'"));
  const res = await handleOmniLink(
    await signed("handshake", config.bootstrap),
    config,
    async () => {
      throw Error("database password=do-not-leak");
    },
  );
  assert.equal(res.status, 503);
  assert(!(await res.text()).includes("do-not-leak"));
});
test("database function and tables are inaccessible to browser roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("SET ROLE " + role);
    await assert.rejects(db.query("SELECT omni_link_action('handshake','{}')"));
    await assert.rejects(
      db.query("SELECT omni_link_configuration_authorize('client', $1, $2, $3)", [
        project,
        owner,
        "a".repeat(32),
      ]),
    );
    await assert.rejects(db.query("SELECT * FROM omni_link_sessions"));
    await assert.rejects(db.query("SELECT * FROM omni_inbound_jobs"));
    await db.exec("RESET ROLE");
  }
});
test("configuration authorization consumes a scoped nonce and audit but creates no jobs or execution grants", async () => {
  const allow = async (client = "mothership-test", nonce = "a".repeat(32)) =>
    (
      await db.query("SELECT omni_link_configuration_authorize($1,$2,$3,$4) AS allowed", [
        client,
        project,
        owner,
        nonce,
      ])
    ).rows[0].allowed;
  assert.equal(await allow(), true);
  assert.equal(await allow(), false);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM omni_link_sessions")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM omni_inbound_jobs")).rows[0].n, 0);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM site_log WHERE action='omni.link.configuration_check'",
      )
    ).rows[0].n,
    1,
  );
  await db.exec("UPDATE automation_policy SET paused=true");
  assert.equal(await allow("mothership-test", "b".repeat(32)), false);
  await db.exec(
    "UPDATE automation_policy SET paused=false; UPDATE owner_projects SET active=false",
  );
  assert.equal(await allow("mothership-test", "c".repeat(32)), false);
  await db.exec("UPDATE owner_projects SET active=true; DELETE FROM user_roles");
  assert.equal(await allow("mothership-test", "d".repeat(32)), false);
});
test("configuration nonce prefixes are literal, rate bounded, and rolled back with failed audits", async () => {
  const call = async (client, nonce) =>
    (
      await db.query("SELECT omni_link_configuration_authorize($1,$2,$3,$4) AS allowed", [
        client,
        project,
        owner,
        nonce,
      ])
    ).rows[0].allowed;
  await db.query("INSERT INTO omni_callback_nonces VALUES ($1,now()-interval '20 minutes')", [
    "link-config:clientXtest:" + "a".repeat(32),
  ]);
  assert.equal(await call("client_test", "a".repeat(32)), true);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM omni_callback_nonces WHERE nonce LIKE 'link-config:clientXtest:%'",
      )
    ).rows[0].n,
    1,
  );
  for (let n = 1; n < 60; n++)
    assert.equal(await call("client_test", n.toString(16).padStart(32, "0")), true);
  assert.equal(await call("client_test", "b".repeat(32)), false);
  await db.exec(
    "ALTER TABLE site_log ADD CONSTRAINT fixture_deny_configuration CHECK (action <> 'omni.link.configuration_check') NOT VALID",
  );
  try {
    await assert.rejects(call("audit-test", "c".repeat(32)));
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM omni_callback_nonces WHERE nonce LIKE 'link-config:audit-test:%'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await db.exec("ALTER TABLE site_log DROP CONSTRAINT fixture_deny_configuration");
  }
});
test("Mothership verifies both real signed metadata hops without executing the runner", async (t) => {
  const mothership = process.env["MOTHERSHIP_TEST_ROOT"];
  if (!mothership) return t.skip("Set MOTHERSHIP_TEST_ROOT for the cross-repository metadata test");
  const { checkJackboyRunnerConfiguration } = await import(
    pathToFileURL(join(mothership, "src/lib/jackboy-link.server.ts")).href
  );
  const { handleOmniConfiguration } = await import("../src/lib/omni-configuration.server.ts");
  const { handleRunnerRequest } = await import("../src/lib/omni-remote-runner.server.ts");
  const { nonceCache } = await import("../src/lib/omni-remote-runner.ts");
  const runnerSecret = "r".repeat(64);
  const runnerOrigin = "https://runner.example";
  const siteEnv = {
    OMNI_LINK_CLIENT_ID: config.clientId,
    OMNI_LINK_PROJECT_ID: project,
    OMNI_LINK_OWNER_ID: owner,
    OMNI_LINK_BOOTSTRAP_KEY: config.bootstrap,
    OMNI_LINK_HMAC_SECRET: config.secret,
    OMNI_LINK_REMOTE_RUNNER_ENABLED: "true",
    OMNI_LINK_REMOTE_RUNNER_URL: runnerOrigin,
    OMNI_LINK_REMOTE_RUNNER_SECRET: runnerSecret,
  };
  const runnerEnv = {
    OMNI_LINK_RUNNER_MODE: "true",
    OMNI_LINK_NODE_RUNNER_ENABLED: "true",
    OMNI_LINK_REMOTE_RUNNER_SECRET: runnerSecret,
  };
  const claim = nonceCache();
  let executions = 0;
  let corruptProof = false;
  const toRunner = async (url, init) => {
    const reply = await handleRunnerRequest(
      new Request(url, init),
      runnerEnv,
      async () => {
        executions++;
        return true;
      },
      () => true,
      claim,
    );
    if (corruptProof) reply.headers.set("x-runner-proof", "0".repeat(64));
    return reply;
  };
  const allow = async (c, nonce) =>
    (
      await db.query("SELECT omni_link_configuration_authorize($1,$2,$3,$4) AS allowed", [
        c.clientId,
        c.projectId,
        c.ownerId,
        nonce,
      ])
    ).rows[0].allowed;
  const toJackboy = async (url, init) =>
    handleOmniConfiguration(new Request(url, init), String(init.body), siteEnv, allow, toRunner);
  const c = { ...config, origin: "https://jackboy.example", runnerOrigin };
  const result = await checkJackboyRunnerConfiguration(c, async () => {}, { fetch: toJackboy });
  assert.deepEqual(result, {
    runnerOrigin,
    runnerMode: true,
    nodeRunnerEnabled: true,
    remoteRunnerSecretConfigured: true,
    runtimeAvailable: true,
  });
  corruptProof = true;
  assert.equal(
    await checkJackboyRunnerConfiguration(c, async () => {}, { fetch: toJackboy }),
    null,
  );
  assert.equal(executions, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM omni_link_sessions")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM omni_inbound_jobs")).rows[0].n, 0);
  assert(!JSON.stringify(result).includes(runnerSecret));
});
test("subprocess has no inherited credentials and a cancelled signal fails", async () => {
  process.env["OMNI_TEST_SENTINEL"] = "do-not-inherit";
  try {
    assert.equal(await runProtocolSelfTest(new AbortController().signal), true);
    const abort = new AbortController();
    abort.abort();
    assert.equal(await runProtocolSelfTest(abort.signal), false);
  } finally {
    delete process.env["OMNI_TEST_SENTINEL"];
  }
});
test("Go OMNI client against real Jackboy handler over verified local TLS", async (t) => {
  if (!process.env["OMNI_INBOX_DIR"])
    return t.skip("Set OMNI_INBOX_DIR to companion inbox checkout for cross-repository test");
  const dir = await mkdtemp(join(tmpdir(), "omni-tls-"));
  const key = join(dir, "key.pem"),
    cert = join(dir, "cert.pem");
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ]);
  const { createLinkServer } = await import("../scripts/omni-link-server.mjs");
  const lost = new Set();
  const server = createLinkServer(
    { key: await readFile(key), cert: await readFile(cert) },
    "https://127.0.0.1:0",
    async (request) => {
      const action = (await request.clone().json()).action;
      const response = await handleOmniLink(request, config, store);
      // Lose one acknowledgement AFTER commit, then let the Go client reconcile.
      if ((action === "submit" || action === "run") && !lost.has(action) && response.ok) {
        lost.add(action);
        return new Response(null, { status: 503 });
      }
      return response;
    },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { stdout } = await exec(
      "go",
      ["test", "./internal/link", "-run", "TestCrossLanguage", "-count=1", "-v"],
      {
        cwd: process.env["OMNI_INBOX_DIR"],
        env: {
          ...process.env,
          LINK_TEST_URL: `https://127.0.0.1:${server.address().port}`,
          LINK_TEST_CERT: cert,
        },
        timeout: 60000,
      },
    );
    assert.match(stdout, /PASS/);
    assert.equal(lost.size, 2);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM omni_inbound_jobs")).rows[0].n, 1);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM site_log WHERE action='omni.link.running'"))
        .rows[0].n,
      1,
    );
    console.log(stdout.trim());
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsupported web runtime does not claim executor readiness or accept jobs", async () => {
  delete process.env["OMNI_LINK_NODE_RUNNER_ENABLED"];
  const handshake = await call("handshake", config.bootstrap);
  assert.equal(handshake.status, 200);
  assert.equal(handshake.ready, false);
  assert.equal(
    (await call("submit", handshake.sessionToken, { jobId: job, kind: "protocol.self-test" }))
      .status,
    503,
  );
});
test("expired owner grant and revocation during execution stop work", async () => {
  config.approvalExpiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call("handshake", config.bootstrap)).status, 403);
  config.approvalExpiresAt = new Date(Date.now() + 3600000).toISOString();
  const token = await connect();
  await call("submit", token, { jobId: job, kind: "protocol.self-test" });
  let started;
  const ready = new Promise((r) => (started = r));
  const running = call(
    "run",
    token,
    { jobId: job },
    (signal) =>
      new Promise((r) => {
        started();
        signal.addEventListener("abort", () => r(false), { once: true });
      }),
  );
  await ready;
  await db.exec("UPDATE automation_policy SET paused=true");
  assert.equal((await running).job.status, "cancelled");
});
test("oversized bodies and signed invalid JSON fail without storing jobs", async () => {
  const large = new Request("https://jackboy.test" + LINK_PATH, {
    method: "POST",
    body: "x".repeat(9000),
  });
  assert.equal((await handleOmniLink(large, config, store)).status, 503);
  const token = await connect();
  const request = await signed("status", token, { jobId: job });
  const headers = new Headers(request.headers);
  headers.set(
    "x-omni-signature",
    await hmacHex(
      config.secret,
      requestMessage(
        headers.get("x-omni-timestamp"),
        headers.get("x-omni-nonce"),
        await digest(token),
        "{",
      ),
    ),
  );
  assert.equal(
    (
      await handleOmniLink(
        new Request(request.url, { method: "POST", headers, body: "{" }),
        config,
        store,
      )
    ).status,
    400,
  );

  assert.equal((await db.query("SELECT count(*)::int AS n FROM omni_inbound_jobs")).rows[0].n, 0);
});
