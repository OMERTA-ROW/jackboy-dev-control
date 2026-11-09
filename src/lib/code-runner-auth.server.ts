import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import { supabaseAdmin as typedDb } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
const db = untyped(typedDb);
import { CODE_ACTION, CODE_WORKFLOW, type CodeScope } from "./code";
import { codeSafetyBlockReason, getCodeSafetyState } from "./code-safety.server";
import {
  classifyPatch,
  expectedEnvironment,
  expectedSubject,
  laneOf,
  type Lane,
  type PatchEvidence,
} from "./code-lane";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "jackboy-code-runner";
const TOKEN_MAX_AGE_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;

type GithubClaims = {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  repository: string;
  ref: string;
  workflow_ref: string;
  sub: string;
  workflow_sha: string;
  sha: string;
  event_name: string;
  environment?: string;
  run_id: string;
  run_attempt: string;
};

function decodeJson(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export async function verifyGithubActionsToken(
  token: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<GithubClaims> {
  if (token.length > 12_000) throw new Error("Invalid GitHub Actions token.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid GitHub Actions token.");
  let header: Record<string, unknown>, claims: GithubClaims;
  try {
    header = decodeJson(parts[0]!);
    claims = decodeJson(parts[1]!) as unknown as GithubClaims;
  } catch {
    throw new Error("Invalid GitHub Actions token.");
  }
  if (
    header["alg"] !== "RS256" ||
    typeof header["kid"] !== "string" ||
    header["kid"].length > 200
  ) {
    throw new Error("Unsupported GitHub Actions token.");
  }

  const response = await fetcher(`${ISSUER}/.well-known/jwks`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("GitHub Actions identity verification is unavailable.");
  const keySet = (await response.json()) as {
    keys?: (JsonWebKey & { kid?: string; use?: string; alg?: string })[];
  };
  const jwk = keySet.keys?.find((key) => key.kid === header["kid"]);
  if (!jwk || jwk.use !== "sig" || jwk.alg !== "RS256" || jwk.kty !== "RSA") {
    throw new Error("GitHub Actions signing key was not recognized.");
  }
  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!valid) throw new Error("GitHub Actions token signature is invalid.");

  const seconds = Math.floor(now / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== ISSUER ||
    audience.length !== 1 ||
    audience[0] !== AUDIENCE ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat > seconds + 60 ||
    claims.exp <= seconds ||
    claims.exp - claims.iat > TOKEN_MAX_AGE_SECONDS ||
    (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds + 60))
  ) {
    throw new Error("GitHub Actions token is expired or has invalid claims.");
  }
  if (
    typeof claims.repository !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(claims.repository) ||
    typeof claims.ref !== "string" ||
    typeof claims.workflow_ref !== "string" ||
    typeof claims.workflow_sha !== "string" ||
    !SHA.test(claims.workflow_sha) ||
    typeof claims.sha !== "string" ||
    !SHA.test(claims.sha) ||
    claims.event_name !== "workflow_dispatch" ||
    !/^\d+$/.test(claims.run_id) ||
    !/^[1-9]\d*$/.test(claims.run_attempt) ||
    !Number.isSafeInteger(Number(claims.run_id)) ||
    !Number.isSafeInteger(Number(claims.run_attempt))
  ) {
    throw new Error("GitHub Actions token is missing required workflow claims.");
  }
  return claims;
}

async function github<T>(repo: string, path: string): Promise<T> {
  const token = process.env["CODE_GITHUB_TOKEN"];
  if (!token) throw new Error("CODE runner authorization is unavailable.");
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
    headers: (() => {
      const headers = new Headers({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Jackboy",
      });
      headers.set("Authorization", ["Bearer", token].join(" "));
      return headers;
    })(),
  });
  if (!response.ok) throw new Error("CODE runner authorization is unavailable.");
  return (await response.json()) as T;
}

export async function verifyWorkflowRun(
  claims: GithubClaims,
  repo: string,
  ref: string,
  workflowSha: string,
  baseSha: string,
  stage: "execute" | "publish" | "finish",
  lane: Lane = "reviewed",
) {
  const expectedRef = `refs/heads/${ref}`;
  // The lane comes from the server-stored request, never from the runner; the signed identity must name its environment.
  if (
    claims.repository !== repo ||
    claims.sub !== expectedSubject(repo, stage, lane, ref) ||
    claims.ref !== expectedRef ||
    claims.workflow_ref !== `${repo}/.github/workflows/${CODE_WORKFLOW}@${expectedRef}` ||
    claims.sha !== baseSha ||
    claims.environment !== expectedEnvironment(stage, lane)
  ) {
    throw new Error("CODE runner identity does not match the approved request.");
  }
  const [repository, workflow, branchFile, runFile] = await Promise.all([
    github<{ default_branch: string }>(repo, ""),
    github<{ state: string }>(repo, `/actions/workflows/${CODE_WORKFLOW}`),
    github<{ sha: string }>(
      repo,
      `/contents/.github/workflows/${CODE_WORKFLOW}?ref=${encodeURIComponent(ref)}`,
    ),
    github<{ sha: string }>(
      repo,
      `/contents/.github/workflows/${CODE_WORKFLOW}?ref=${encodeURIComponent(claims.workflow_sha)}`,
    ),
  ]);
  if (
    repository.default_branch !== ref ||
    workflow.state !== "active" ||
    branchFile.sha !== workflowSha ||
    runFile.sha !== workflowSha
  ) {
    throw new Error("CODE runner workflow or revision changed after approval.");
  }
  const run = await github<{
    jobs: { name: string; status: string; conclusion: string | null; run_attempt: number }[];
  }>(repo, `/actions/runs/${claims.run_id}/jobs?filter=latest`);
  const jobs = run.jobs.filter((job) => job.run_attempt === Number(claims.run_attempt));
  if (stage === "execute") {
    if (!jobs.some((job) => job.name === "prepare" && job.status === "in_progress")) {
      throw new Error("CODE execution job is not the authorized runner stage.");
    }
  } else if (
    stage === "publish" &&
    (!jobs.some((job) => job.name === "draft_pr" && job.status === "in_progress") ||
      !["prepare", "validate"].every((name) =>
        jobs.some(
          (job) => job.name === name && job.status === "completed" && job.conclusion === "success",
        ),
      ))
  ) {
    throw new Error("CODE publisher stage is not independently authorized.");
  } else if (
    stage === "finish" &&
    !jobs.some((job) => job.name === "finish" && job.status === "in_progress")
  ) {
    throw new Error("CODE finalization stage is not the authorized runner stage.");
  }
}

export async function handleCodeRunnerClaim(request: Request): Promise<Response> {
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  const authorization = request.headers.get("authorization") ?? "";
  const authParts = authorization.split(" ");
  const bearer =
    authParts.length === 2 && authParts[0]?.toLowerCase() === "bearer" ? authParts[1] : undefined;
  if (!bearer) return reply({ error: "GitHub Actions identity required." }, 401);
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 4_000) return reply({ error: "Invalid request." }, 400);
    const body = JSON.parse(text) as { requestId?: unknown; stage?: unknown; patch?: unknown };
    if (
      typeof body.requestId !== "string" ||
      !UUID.test(body.requestId) ||
      (body.stage !== "execute" && body.stage !== "publish")
    ) {
      return reply({ error: "Invalid request." }, 400);
    }
    const claims = await verifyGithubActionsToken(bearer);
    const { data: row, error } = await db
      .from("action_requests")
      .select(
        "id, action, project_id, requested_by, decided_by, decided_at, status, mode, expires_at, revoked_at, runner_claimed_at, runner_publish_claimed_at, runner_run_id, runner_run_attempt, runner_revision, runner_workflow_sha, resources",
      )
      .eq("id", body.requestId)
      .single();
    if (error || !row) return reply({ error: "CODE approval was not found." }, 403);
    const scope = row.resources as unknown as CodeScope & { baseSha?: string };
    const expiry = Date.parse(row.expires_at ?? "");
    if (
      row.action !== CODE_ACTION ||
      row.status !== "allowed" ||
      row.mode !== "once" ||
      row.decided_by !== row.requested_by ||
      !row.decided_at ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      row.revoked_at ||
      typeof row.requested_by !== "string" ||
      !UUID.test(row.requested_by) ||
      typeof scope.repo !== "string" ||
      !/^[\w.-]+\/[\w.-]+$/.test(scope.repo) ||
      typeof scope.ref !== "string" ||
      !/^[\w./-]{1,100}$/.test(scope.ref) ||
      scope.ref.includes("..") ||
      scope.ref.includes("//") ||
      scope.ref.startsWith("/") ||
      scope.ref.endsWith("/") ||
      scope.ref.endsWith(".") ||
      typeof scope.workflowSha !== "string" ||
      !SHA.test(scope.workflowSha) ||
      typeof scope.baseSha !== "string" ||
      !SHA.test(scope.baseSha) ||
      typeof scope.sessionHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(scope.sessionHash) ||
      typeof scope.instruction !== "string" ||
      !scope.instruction.trim() ||
      scope.instruction.length > 4000 ||
      !["dispatch", "retry"].includes(scope.operation)
    ) {
      return reply({ error: "CODE approval is expired, revoked, or does not match." }, 403);
    }
    const controls = await getCodeSafetyState();
    const approvedTargets = controls.allowedTargets;
    const target = approvedTargets[scope.repo];
    if (target?.ref !== scope.ref || target.workflowSha !== scope.workflowSha) {
      return reply({ error: "CODE approval no longer matches the owner-approved runner." }, 403);
    }
    if (body.stage === "execute" && row.runner_claimed_at) {
      return reply({ error: "CODE approval was already claimed." }, 409);
    }
    if (body.stage === "publish" && row.runner_publish_claimed_at) {
      return reply({ error: "CODE publishing approval was already claimed." }, 409);
    }
    if (body.stage === "execute") {
      const blocked = await codeSafetyBlockReason(scope.repo, Date.now(), { refreshMeter: true });
      if (blocked) return reply({ error: blocked }, 409);
    }
    const lane = laneOf(scope as { lane?: unknown });
    if (lane === "auto") {
      const { autoLaneAllowed } = await import("./code-lane.server");
      if (!(await autoLaneAllowed(scope.repo)))
        return reply({ error: "The automatic lane isn't on for this site." }, 403);
      if (body.stage === "publish") {
        const check = classifyPatch(body.patch as PatchEvidence);
        if (!check.lowRisk)
          return reply(
            { error: `This patch needs the reviewed lane: ${check.reasons.join(" ")}` },
            409,
          );
      }
    }
    const acceptance = (scope as { acceptance?: unknown }).acceptance === true;
    if (acceptance) {
      const { acceptanceScopeBlockReason } = await import("./code-acceptance");
      const blocked = acceptanceScopeBlockReason(scope, controls.perTaskReserveUsd);
      if (blocked) return reply({ error: blocked }, 403);
      const guard = await db.rpc("code_acceptance_guard_status");
      if (guard.error || guard.data !== true)
        return reply({ error: "The acceptance database guard is unavailable." }, 409);
    }
    await verifyWorkflowRun(
      claims,
      scope.repo,
      scope.ref,
      scope.workflowSha,
      scope.baseSha,
      body.stage,
      lane,
    );
    if (acceptance && body.stage === "publish") {
      // Fail closed: the exact patch must touch only the acceptance file before any draft PR can open.
      const { acceptancePublishGate } = await import("./code-acceptance.server");
      const gate = await acceptancePublishGate(
        scope.repo,
        Number(claims.run_id),
        Number(claims.run_attempt),
        process.env["CODE_GITHUB_TOKEN"],
      );
      const logged = await db.from("audit_logs").insert({
        actor: row.requested_by,
        action: gate.ok ? "code.acceptance_publish_allowed" : "code.acceptance_publish_blocked",
        detail: {
          request: body.requestId,
          run_id: Number(claims.run_id),
          run_attempt: Number(claims.run_attempt),
          reasons: gate.reasons,
        },
        outcome: gate.ok ? "allowed" : "denied",
      });
      if (logged.error)
        return reply({ error: "Acceptance publishing decision could not be audited." }, 409);
      if (!gate.ok)
        return reply({ error: `Acceptance test blocked: ${gate.reasons.join(" ")}` }, 409);
    }
    const { data, error: claimError } = await db.rpc("claim_code_runner", {
      p_request_id: body.requestId,
      p_stage: body.stage,
      p_repository: claims.repository,
      p_ref: scope.ref,
      p_workflow_blob_sha: scope.workflowSha,
      p_run_id: Number(claims.run_id),
      p_run_attempt: Number(claims.run_attempt),
      p_revision: claims.sha,
      p_owner_id: row.requested_by,
      p_session_hash: scope.sessionHash,
      p_operation: scope.operation,
    });
    if (claimError || !data?.length)
      return reply({ error: "CODE approval could not be claimed." }, 409);
    if (body.stage === "publish") return reply({ authorized: true });
    const { data: slot, error: slotError } = await db.rpc("claim_code_runtime_slot", {
      p_request_id: body.requestId,
      p_repository: claims.repository,
      p_ref: scope.ref,
      p_workflow_sha: scope.workflowSha,
      p_run_id: Number(claims.run_id),
    });
    if (slotError || slot !== true)
      return reply({ error: "CODE runtime safety gate blocked execution." }, 409);
    return reply({
      authorized: true,
      requestId: body.requestId,
      operation: scope.operation,
      instruction: scope.instruction,
      revision: scope.baseSha,
    });
  } catch {
    return reply({ error: "CODE runner authorization failed closed." }, 403);
  }
}

export async function handleCodeRunnerFinish(request: Request): Promise<Response> {
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  const authorization = request.headers.get("authorization") ?? "";
  const authParts = authorization.split(" ");
  const bearer =
    authParts.length === 2 && authParts[0]?.toLowerCase() === "bearer" ? authParts[1] : undefined;
  if (!bearer) return reply({ error: "GitHub Actions identity required." }, 401);
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 2_000) return reply({ error: "Invalid request." }, 400);
    const body = JSON.parse(text) as { requestId?: unknown; outcome?: unknown };
    if (
      typeof body.requestId !== "string" ||
      !UUID.test(body.requestId) ||
      !["success", "failure", "cancelled"].includes(String(body.outcome))
    )
      return reply({ error: "Invalid request." }, 400);
    const claims = await verifyGithubActionsToken(bearer);
    const { data: row, error } = await db
      .from("action_requests")
      .select(
        "id, action, requested_by, status, mode, expires_at, revoked_at, runner_claimed_at, runner_run_id, runner_run_attempt, runner_revision, runner_workflow_sha, resources",
      )
      .eq("id", body.requestId)
      .single();
    if (
      error ||
      !row ||
      row.action !== CODE_ACTION ||
      !row.runner_claimed_at ||
      row.status !== "allowed"
    ) {
      return reply({ error: "CODE approval was not found or was never claimed." }, 403);
    }
    const scope = row.resources as unknown as CodeScope & { baseSha?: string };
    if (!scope.repo || !scope.ref || !scope.workflowSha || !scope.baseSha) {
      return reply({ error: "CODE finalization scope is invalid." }, 403);
    }
    await verifyWorkflowRun(
      claims,
      scope.repo,
      scope.ref,
      scope.workflowSha,
      scope.baseSha,
      "finish",
    );
    if (row.revoked_at)
      return reply({ error: "CODE request was revoked before finalization." }, 403);
    const { error: finishError } = await db.rpc("finish_code_runtime_slot", {
      p_request_id: body.requestId,
      p_run_id: Number(claims.run_id),
      p_run_attempt: Number(claims.run_attempt),
      p_outcome: body.outcome as "success" | "failure" | "cancelled",
    });
    if (finishError) return reply({ error: "CODE task completion could not be recorded." }, 409);
    if (body.outcome === "success" && typeof scope.correlation === "string") {
      const { logPatchTrial } = await import("./code-lane.server");
      await logPatchTrial(body.requestId, scope.repo, scope.baseSha, scope.correlation);
    }
    return reply({ recorded: true });
  } catch {
    return reply({ error: "CODE task finalization failed closed." }, 403);
  }
}
