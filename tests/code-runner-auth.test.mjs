import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { registerHooks } from "node:module";

const requestId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const workflowSha = "a".repeat(40);
const revision = "b".repeat(40);
const sessionHash = "c".repeat(64);
const privateKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...privateKeyPair.publicKey.export({ format: "jwk" }),
  kid: "runner-test",
  use: "sig",
  alg: "RS256",
};
let row;
let jobs;
let failGithub;
let failIdentity;
let rpcCalls;
let slotCalls;
let githubCalls;
let claimedArgs;
let safetyState;
let acceptanceGuard;
let auditFails;
let gateResult;
let gateAudits;

const scope = () => ({
  repo: "owner/repo",
  ref: "main",
  workflowSha,
  baseSha: revision,
  instruction: "Fix the footer",
  sessionHash,
  correlation: requestId,
  operation: "dispatch",
});

class ApprovalQuery {
  constructor() {
    this.filters = [];
  }
  select() {
    return this;
  }
  insert(value) {
    gateAudits.push(value);
    return Promise.resolve({ error: auditFails ? { message: "audit unavailable" } : null });
  }
  eq(key, value) {
    this.filters.push((candidate) => candidate[key] === value);
    return this;
  }
  single() {
    const result = this.filters.every((filter) => filter(row)) ? row : null;
    return Promise.resolve({ data: result, error: result ? null : { message: "not found" } });
  }
}

globalThis.__claimDb = {
  from: () => new ApprovalQuery(),
  async rpc(_name, args) {
    if (_name === "code_acceptance_guard_status") {
      return { data: acceptanceGuard, error: null };
    }
    if (_name === "claim_code_runtime_slot") {
      slotCalls++;
      return { data: true, error: null };
    }
    rpcCalls++;
    claimedArgs = args;
    if (args.p_stage === "execute") {
      if (row.runner_claimed_at) return { data: null, error: { message: "already claimed" } };
      Object.assign(row, {
        runner_claimed_at: new Date().toISOString(),
        runner_run_id: args.p_run_id,
        runner_run_attempt: args.p_run_attempt,
        runner_revision: args.p_revision,
        runner_workflow_sha: args.p_workflow_blob_sha,
      });
    } else {
      if (
        !row.runner_claimed_at ||
        row.runner_publish_claimed_at ||
        row.runner_run_id !== args.p_run_id ||
        row.runner_revision !== args.p_revision
      )
        return { data: null, error: { message: "publisher claim mismatch" } };
      row.runner_publish_claimed_at = new Date().toISOString();
    }
    return { data: [{ request_id: requestId }], error: null };
  },
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/integrations/supabase/client.server") {
      return next(
        "data:text/javascript,export const supabaseAdmin = globalThis.__claimDb",
        context,
      );
    }
    if (specifier === "./code-safety.server") {
      return next(
        "data:text/javascript,export const getCodeSafetyState=async()=>globalThis.__codeSafety;export const codeSafetyBlockReason=async(repo,now,opts)=>{globalThis.__meterRefreshes=(globalThis.__meterRefreshes??0)+(opts?.refreshMeter?1:0);return null}",
        context,
      );
    }
    if (specifier === "./code-lane.server") {
      return next(
        "data:text/javascript,export const autoLaneAllowed=async()=>globalThis.__autoLane===true;export const logPatchTrial=async()=>{}",
        context,
      );
    }
    if (specifier === "./code-acceptance.server") {
      return next(
        "data:text/javascript,export const acceptancePublishGate=async()=>globalThis.__acceptanceGate()",
        context,
      );
    }
    if (specifier.startsWith("./") && !/\.[a-z]+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { handleCodeRunnerClaim, verifyGithubActionsToken, verifyWorkflowRun } =
  await import("../src/lib/code-runner-auth.server.ts");

globalThis.fetch = async (input) => {
  const url = new URL(input);
  githubCalls.push(`${url.pathname}${url.search}`);
  if (url.hostname === "token.actions.githubusercontent.com") {
    if (failIdentity) return new Response(null, { status: 503 });
    return Response.json({ keys: [jwk] });
  }
  if (failGithub) return new Response(null, { status: 503 });
  if (
    url.pathname === "/repos/owner/repo" ||
    url.pathname === "/repos/OMERTA-ROW/jackboy-dev-control"
  )
    return Response.json({ default_branch: "main" });
  if (url.pathname.endsWith("/actions/workflows/code.yml"))
    return Response.json({ state: "active" });
  if (url.pathname.endsWith("/contents/.github/workflows/code.yml")) {
    return Response.json({ sha: workflowSha });
  }
  if (url.pathname.endsWith("/actions/runs/42/jobs")) return Response.json({ jobs });
  throw new Error(`Unexpected authorization request ${url.pathname}`);
};

function makeToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const environment = overrides.environment ?? "CODE";
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "jackboy-code-runner",
    iat: now - 5,
    exp: now + 300,
    repository: "owner/repo",
    ref: "refs/heads/main",
    workflow_ref: "owner/repo/.github/workflows/code.yml@refs/heads/main",
    sub: `repo:owner/repo:environment:${environment}`,
    workflow_sha: workflowSha,
    sha: revision,
    event_name: "workflow_dispatch",
    environment,
    run_id: "42",
    run_attempt: "1",
    ...overrides,
  };
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "runner-test" })).toString(
    "base64url",
  );
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    privateKeyPair.privateKey,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

async function claim(stage = "execute", token = makeToken()) {
  return handleCodeRunnerClaim(
    new Request("https://app.example/api/public/code/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId, stage }),
    }),
  );
}

beforeEach(() => {
  row = {
    id: requestId,
    action: "code_workflow",
    project_id: "00000000-0000-4000-8000-000000000003",
    requested_by: ownerId,
    decided_by: ownerId,
    decided_at: new Date().toISOString(),
    status: "allowed",
    mode: "once",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    revoked_at: null,
    runner_claimed_at: null,
    runner_publish_claimed_at: null,
    runner_run_id: null,
    runner_run_attempt: null,
    runner_revision: null,
    runner_workflow_sha: null,
    resources: scope(),
  };
  jobs = [{ name: "prepare", status: "in_progress", conclusion: null, run_attempt: 1 }];
  failGithub = failIdentity = false;
  rpcCalls = 0;
  slotCalls = 0;
  claimedArgs = null;
  githubCalls = [];
  safetyState = {
    enabled: true,
    killSwitch: false,
    allowedTargets: { "owner/repo": { ref: "main", workflowSha } },
    activeRequestId: null,
    consecutiveFailures: 0,
    dailySpendLimitUsd: 5,
    providerSpendTodayUsd: 0,
    providerUsageAt: new Date().toISOString(),
    providerBudgetEnforced: true,
    reservedHoldsUsd: 0,
    perTaskReserveUsd: 1,
    usageSpike: false,
    totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 0 },
    spendMeter: { ok: true, reasons: [], measuredAt: new Date().toISOString(), measuredTodayUsd: 0, gatewayTodayUsd: 0, providerTodayUsd: 0, gatewayHourUsd: 0, unreportedDays: [], bypassDays: [] },
  };
  acceptanceGuard = true;
  auditFails = false;
  gateAudits = [];
  gateResult = { ok: true, reasons: [] };
  globalThis.__acceptanceGate = () => gateResult;
  globalThis.__meterRefreshes = 0;
  globalThis.__autoLane = false;
  globalThis.__codeSafety = safetyState;
  process.env.CODE_TARGETS = JSON.stringify({ "owner/repo": { ref: "main", workflowSha } });
  process.env.CODE_GITHUB_TOKEN = "test-runner-auth-token";
});

test("execute claim is bound to the approved request scope and can only be claimed once", async () => {
  const claims = await verifyGithubActionsToken(makeToken(), async () =>
    Response.json({ keys: [jwk] }),
  );
  await verifyWorkflowRun(claims, "owner/repo", "main", workflowSha, revision, "execute");
  const response = await claim();
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ body, githubCalls }));
  assert.equal(body.authorized, true);
  assert.equal(body.requestId, requestId);
  assert.equal(body.instruction, "Fix the footer");
  assert.equal(body.revision, revision);
  assert.equal(row.runner_run_id, 42);
  assert.equal(row.runner_revision, revision);
  assert.equal(claimedArgs.p_request_id, requestId);
  assert.equal(claimedArgs.p_owner_id, ownerId);
  assert.equal(claimedArgs.p_session_hash, sessionHash);
  assert.equal(claimedArgs.p_repository, "owner/repo");
  assert.equal(claimedArgs.p_operation, "dispatch");
  assert.equal(claimedArgs.p_revision, revision);
  assert.equal(rpcCalls, 1);
  assert.equal(slotCalls, 1);
  assert.equal(globalThis.__meterRefreshes, 1, "the live meter is re-measured right before the claim");
  assert.equal((await claim()).status, 409);
  assert.equal(rpcCalls, 1);
});

test("concurrent execute claims have one winner", async () => {
  const responses = await Promise.all([claim(), claim()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(rpcCalls, 2);
  assert.equal(row.runner_run_id, 42);
});

test("expired, revoked, mismatched and unapproved requests fail before atomic claim", async () => {
  row.expires_at = new Date(0).toISOString();
  assert.equal((await claim()).status, 403);
  row.expires_at = new Date(Date.now() + 60_000).toISOString();
  row.revoked_at = new Date().toISOString();
  assert.equal((await claim()).status, 403);
  row.revoked_at = null;
  assert.equal((await claim("execute", makeToken({ sha: "d".repeat(40) }))).status, 403);
  assert.equal((await claim("execute", makeToken({ repository: "other/repo" }))).status, 403);
  assert.equal((await claim("execute", makeToken({ ref: "refs/heads/attacker" }))).status, 403);
  assert.equal((await claim("execute", makeToken({ environment: "CODE-PUBLISH" }))).status, 403);
  row.status = "pending";
  assert.equal((await claim()).status, 403);
  assert.equal(rpcCalls, 0);
});

test("publishing is a separate, one-time claim requiring successful prepare and validate jobs", async () => {
  jobs = [
    { name: "prepare", status: "completed", conclusion: "success", run_attempt: 1 },
    { name: "validate", status: "completed", conclusion: "success", run_attempt: 1 },
    { name: "draft_pr", status: "in_progress", conclusion: null, run_attempt: 1 },
  ];
  assert.equal((await claim("publish", makeToken({ environment: "CODE-PUBLISH" }))).status, 409);
  assert.equal(row.runner_publish_claimed_at, null);
  jobs = [{ name: "prepare", status: "in_progress", conclusion: null, run_attempt: 1 }];
  assert.equal((await claim()).status, 200);
  jobs = [
    { name: "prepare", status: "completed", conclusion: "success", run_attempt: 1 },
    { name: "draft_pr", status: "in_progress", conclusion: null, run_attempt: 1 },
  ];
  // Without a successful, separate validation job the publisher is refused.
  assert.notEqual((await claim("publish", makeToken({ environment: "CODE-PUBLISH" }))).status, 200);
  jobs[1] = { name: "validate", status: "completed", conclusion: "failure", run_attempt: 1 };
  jobs.push({ name: "draft_pr", status: "in_progress", conclusion: null, run_attempt: 1 });
  assert.notEqual((await claim("publish", makeToken({ environment: "CODE-PUBLISH" }))).status, 200);
  assert.equal(row.runner_publish_claimed_at, null);
  jobs[1] = { name: "validate", status: "completed", conclusion: "success", run_attempt: 1 };
  const publishes = await Promise.all([
    claim("publish", makeToken({ environment: "CODE-PUBLISH" })),
    claim("publish", makeToken({ environment: "CODE-PUBLISH" })),
  ]);
  assert.deepEqual(publishes.map((response) => response.status).sort(), [200, 409]);
  assert.ok(row.runner_publish_claimed_at);
  assert.equal((await claim("publish", makeToken({ environment: "CODE-PUBLISH" }))).status, 409);
});

test("expired and tampered GitHub identity tokens are rejected", async () => {
  assert.equal(
    (await claim("execute", makeToken({ exp: Math.floor(Date.now() / 1000) - 1 }))).status,
    403,
  );
  assert.equal((await claim("execute", makeToken({ aud: "another-service" }))).status, 403);
  const token = makeToken();
  assert.equal((await claim("execute", `${token.slice(0, -4)}AAAA`)).status, 403);
  assert.equal(rpcCalls, 0);
});

test("identity and GitHub verification outages fail closed without consuming approval", async () => {
  failIdentity = true;
  assert.equal((await claim()).status, 403);
  assert.equal(row.runner_claimed_at, null);
  failIdentity = false;
  failGithub = true;
  assert.equal((await claim()).status, 403);
  assert.equal(row.runner_claimed_at, null);
  assert.equal(rpcCalls, 0);
});

test("changed owner runner allowlist fails closed", async () => {
  safetyState.allowedTargets = {};
  assert.equal((await claim()).status, 403);
  assert.equal(row.runner_claimed_at, null);
  assert.equal(rpcCalls, 0);
});

async function laneClaim(stage, environment, patch) {
  return handleCodeRunnerClaim(
    new Request("https://app.example/api/public/code/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${makeToken({ environment })}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId, stage, ...(patch ? { patch } : {}) }),
    }),
  );
}
const smallPatch = { fileCount: 1, files: [{ path: "src/components/Footer.tsx", status: "modified", additions: 3, deletions: 1 }] };
const donePrepare = () => {
  jobs = [
    { name: "prepare", status: "completed", conclusion: "success", run_attempt: 1 },
    { name: "validate", status: "completed", conclusion: "success", run_attempt: 1 },
    { name: "draft_pr", status: "in_progress", conclusion: null, run_attempt: 1 },
  ];
};

test("reviewed lane: a runner claiming the automatic environments is refused", async () => {
  assert.equal((await laneClaim("execute", "CODE-AUTO")).status, 403);
  assert.equal(rpcCalls, 0);
});

test("automatic lane needs the site's switch on, even with an automatic identity", async () => {
  row.resources = { ...scope(), lane: "auto" };
  assert.equal((await laneClaim("execute", "CODE-AUTO")).status, 403);
  assert.equal(rpcCalls, 0);
});

test("automatic lane: execute must come from CODE-AUTO, never the reviewed environment", async () => {
  row.resources = { ...scope(), lane: "auto" };
  globalThis.__autoLane = true;
  assert.equal((await laneClaim("execute", "CODE")).status, 403);
  assert.equal(rpcCalls, 0);
  assert.equal((await laneClaim("execute", "CODE-AUTO")).status, 200);
});

test("automatic lane: publishing re-checks the actual patch; risky or missing reports go to review", async () => {
  row.resources = { ...scope(), lane: "auto" };
  globalThis.__autoLane = true;
  assert.equal((await laneClaim("execute", "CODE-AUTO")).status, 200);
  donePrepare();
  assert.equal((await laneClaim("publish", "CODE-PUBLISH-AUTO")).status, 409, "no patch report");
  assert.equal((await laneClaim("publish", "CODE-PUBLISH-AUTO", { fileCount: 1, files: [{ path: ".github/workflows/code.yml", status: "modified", additions: 1, deletions: 0 }] })).status, 409);
  assert.equal((await laneClaim("publish", "CODE-PUBLISH-AUTO", { fileCount: 1, files: [{ path: "src/a.ts", status: "modified", additions: 60, deletions: 0 }] })).status, 409);
  assert.equal(row.runner_publish_claimed_at, null);
  assert.equal((await laneClaim("publish", "CODE-PUBLISH", smallPatch)).status, 403, "reviewed publish identity can't serve an automatic run");
  assert.equal((await laneClaim("publish", "CODE-PUBLISH-AUTO", smallPatch)).status, 200);
});

test("a request stored with any other lane value stays reviewed", async () => {
  row.resources = { ...scope(), lane: "AUTO" };
  globalThis.__autoLane = true;
  assert.equal((await laneClaim("execute", "CODE-AUTO")).status, 403);
  assert.equal((await laneClaim("execute", "CODE")).status, 200);
});

const acceptanceRepo = "OMERTA-ROW/jackboy-dev-control";
function acceptanceSetup() {
  row.resources = { ...scope(), repo: acceptanceRepo, acceptance: true, taskBudgetUsd: 1 };
  safetyState.allowedTargets[acceptanceRepo] = { ref: "main", workflowSha };
}
const acceptanceToken = (environment = "CODE") =>
  makeToken({
    repository: acceptanceRepo,
    workflow_ref: `${acceptanceRepo}/.github/workflows/code.yml@refs/heads/main`,
    sub: `repo:${acceptanceRepo}:environment:${environment}`,
    environment,
  });

test("acceptance claims require fixed scope, reviewed lane and installed database guard", async () => {
  acceptanceSetup();
  row.resources.repo = "owner/repo";
  assert.equal((await claim()).status, 403);
  acceptanceSetup();
  row.resources.lane = "auto";
  globalThis.__autoLane = true;
  assert.equal((await claim("execute", acceptanceToken("CODE-AUTO"))).status, 403);
  acceptanceSetup();
  safetyState.perTaskReserveUsd = 2;
  assert.equal((await claim("execute", acceptanceToken())).status, 403);
  safetyState.perTaskReserveUsd = 1;
  acceptanceGuard = false;
  assert.equal((await claim("execute", acceptanceToken())).status, 409);
  assert.equal(rpcCalls, 0);
  assert.equal(slotCalls, 0);
});

test("acceptance publish cannot claim on missing evidence or audit failure", async () => {
  acceptanceSetup();
  assert.equal((await claim("execute", acceptanceToken())).status, 200);
  donePrepare();
  gateResult = { ok: false, reasons: ["Evidence unavailable"] };
  assert.equal((await claim("publish", acceptanceToken("CODE-PUBLISH"))).status, 409);
  assert.equal(row.runner_publish_claimed_at, null);
  gateResult = { ok: true, reasons: [] };
  auditFails = true;
  assert.equal((await claim("publish", acceptanceToken("CODE-PUBLISH"))).status, 409);
  assert.equal(row.runner_publish_claimed_at, null);
  assert.equal(rpcCalls, 1);
  assert.equal(gateAudits.length, 2);
  auditFails = false;
  assert.equal((await claim("publish", acceptanceToken("CODE-PUBLISH"))).status, 200);
  assert.ok(row.runner_publish_claimed_at);
});
