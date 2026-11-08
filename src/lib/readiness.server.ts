// Server-only live readiness. Observations are database reads of real use; Tests are read-only probes
// whose results are appended to the site log. Nothing here changes CODE, pause, pins or GitHub.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
import { logSiteStrict } from "./site-log.server";
import { CODE_WORKFLOW } from "./code";
import { parseSpendMeter, parseTotalSpendGuard, meterReasonText } from "./code-safety";
import {
  READINESS,
  acceptanceResult,
  appPrivilegeResult,
  combine,
  gatewayObservation,
  latestTests,
  omniSessionObservation,
  passkeyObservation,
  runtimeObservation,
  spendObservation,
  PUBLISHED_RP_ID,
  type ReadinessId,
  type ReadinessResult,
  type ReadinessStatus,
} from "./readiness";

const db = untyped(supabaseAdmin);
const JACKBOY_REPO = "OMERTA-ROW/jackboy-dev-control";
const OMNI_REPO = "OMERTA-ROW/Omni";
const PUBLISHED_URL = `https://${PUBLISHED_RP_ID}/`;
export const READINESS_TEST_ACTION = "readiness.test";

type Probe = { status: ReadinessStatus; reason: string };

async function github<T>(repo: string | null, path: string): Promise<T> {
  let token: string | undefined;
  if (repo === JACKBOY_REPO) token = process.env["CODE_GITHUB_TOKEN"];
  if (!token) {
    const { githubTokenFor, anyInstallationToken } = await import("./github-app.server");
    token = repo
      ? (await githubTokenFor(repo))?.token
      : ((await anyInstallationToken()) ?? undefined);
  }
  if (!token) throw new Error("GitHub is not connected for this check.");
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Jackboy",
      Authorization: ["Bearer", token].join(" "),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  return (await response.json()) as T;
}

/** GitHub's on/off state of the Jackboy CODE workflow ("active", "disabled_manually", …); null when unreadable. */
export async function codeWorkflowState(): Promise<string | null> {
  try {
    const w = await github<{ state?: unknown }>(
      JACKBOY_REPO,
      `/repos/${JACKBOY_REPO}/actions/workflows/${CODE_WORKFLOW}`,
    );
    return typeof w.state === "string" ? w.state : null;
  } catch {
    return null;
  }
}

async function readControls() {
  const [controls, guard, meter] = await Promise.all([
    db
      .from("code_runtime_controls")
      .select("enabled, kill_switch, provider_hard_cap_verified, allowed_targets")
      .eq("singleton", true)
      .single(),
    db.rpc("code_total_spend_guard_status"),
    db.rpc("code_spend_meter_status"),
  ]);
  const c = controls.error || !controls.data ? null : (controls.data as Record<string, unknown>);
  return {
    controls: c
      ? {
          enabled: c["enabled"] === true,
          killSwitch: c["kill_switch"] === true,
          hardCap: c["provider_hard_cap_verified"] === true,
          targets: c["allowed_targets"],
        }
      : null,
    guard: parseTotalSpendGuard(guard.error ? null : guard.data),
    meter: parseSpendMeter(meter.error ? null : meter.data),
  };
}

/** Cheap database-only reads of real use anywhere on the site, combined with the newest stored Tests. */
export async function observeReadiness(): Promise<{
  checkedAt: string;
  items: Record<ReadinessId, ReadinessResult>;
}> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const [tests, state, grants, tested, call, session] = await Promise.all([
    db
      .from("site_log")
      .select("at, detail")
      .eq("action", READINESS_TEST_ACTION)
      .order("at", { ascending: false })
      .limit(200),
    readControls(),
    db
      .from("step_up_grants")
      .select("created_at, action, credential_id")
      .order("created_at", { ascending: false })
      .limit(25),
    db
      .from("audit_logs")
      .select("at, detail")
      .eq("action", "passkey.tested")
      .eq("outcome", "ok")
      .order("at", { ascending: false })
      .limit(10),
    db
      .from("code_provider_calls")
      .select("finished_at, status, model")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1),
    db
      .from("omni_link_sessions")
      .select("expires_at")
      .order("expires_at", { ascending: false })
      .limit(1),
  ]);

  // Passkey uses: step-up grants (any sensitive action) plus explicit passkey tests, each with its site.
  const grantRows = (grants.data ?? []) as {
    created_at: string;
    action: string;
    credential_id: string;
  }[];
  const credIds = [...new Set(grantRows.map((g) => g.credential_id))];
  const keys = credIds.length
    ? (((
        await db.from("owner_passkeys").select("credential_id, rp_id").in("credential_id", credIds)
      ).data ?? []) as { credential_id: string; rp_id: string | null }[])
    : [];
  const rpFor = new Map(keys.map((k) => [k.credential_id, k.rp_id]));
  const uses = [
    ...grantRows.map((g) => ({
      at: g.created_at,
      rpId: rpFor.get(g.credential_id) ?? null,
      action: g.action.replace(/_/g, " "),
    })),
    ...((tested.data ?? []) as { at: string; detail: { site?: string } }[]).map((t) => ({
      at: t.at,
      rpId: t.detail?.site ?? null,
      action: "passkey test",
    })),
  ];

  const stored = latestTests((tests.data ?? []) as { at: string; detail: unknown }[]);
  const c = state.controls;
  const guardOk = !!state.guard && state.guard.enforced && state.guard.limitUsd > 0;
  const lastCall = (
    (call.data ?? []) as { finished_at: string; status: string; model: string }[]
  )[0];
  const lastSession = ((session.data ?? []) as { expires_at: string }[])[0];

  const live: Partial<Record<ReadinessId, ReadinessResult | null>> = {
    code_runtime: runtimeObservation(c, at),
    spend_enforcement: spendObservation(
      {
        guardOk,
        meterOk: state.meter?.ok === true,
        hardCap: c?.hardCap === true,
        reasons: state.meter && !state.meter.ok ? state.meter.reasons.map(meterReasonText) : [],
      },
      at,
    ),
    physical_passkey: passkeyObservation(uses),
    provider_gateway: gatewayObservation(
      lastCall
        ? { finishedAt: lastCall.finished_at, status: lastCall.status, model: lastCall.model }
        : null,
    ),
    omni_bridge: omniSessionObservation(lastSession?.expires_at ?? null, now),
  };
  const items = Object.fromEntries(
    READINESS.map((def) => [def.id, combine(stored.get(def.id), live[def.id] ?? null)]),
  ) as Record<ReadinessId, ReadinessResult>;
  return { checkedAt: at, items };
}

async function probe(id: ReadinessId): Promise<Probe> {
  switch (id) {
    case "code_runtime": {
      const { controls } = await readControls();
      const r = runtimeObservation(controls, new Date().toISOString());
      return { status: r.status, reason: r.reason };
    }
    case "spend_enforcement": {
      const s = await readControls();
      const r = spendObservation(
        {
          guardOk: !!s.guard && s.guard.enforced && s.guard.limitUsd > 0,
          meterOk: s.meter?.ok === true,
          hardCap: s.controls?.hardCap === true,
          reasons: s.meter && !s.meter.ok ? s.meter.reasons.map(meterReasonText) : [],
        },
        new Date().toISOString(),
      );
      return { status: r.status, reason: r.reason };
    }
    case "workflow_pins": {
      const [{ controls }, file, state] = await Promise.all([
        readControls(),
        github<{ sha: string }>(
          JACKBOY_REPO,
          `/repos/${JACKBOY_REPO}/contents/.github/workflows/${CODE_WORKFLOW}?ref=main`,
        ),
        codeWorkflowState(),
      ]);
      const { workflowPinReport, workflowStateProblem } = await import("./code-workflow-readiness");
      const report = workflowPinReport(
        controls?.targets ?? null,
        process.env["CODE_TARGETS"],
        file.sha,
      );
      const off = workflowStateProblem(state);
      if (report.matches && off)
        return { status: "OWNER ACTION", reason: `Pins match (${file.sha.slice(0, 12)}), but: ${off}` };
      return report.matches
        ? {
            status: "PASS",
            reason: `GitHub main, CODE_TARGETS and the database all pin ${file.sha.slice(0, 12)}.`,
          }
        : {
            status: "OWNER ACTION",
            reason:
              "The pins differ from GitHub main. Ask Jackboy in Chat for an owner-approved pin resync.",
          };
    }
    case "reviewer_gates": {
      type Env = {
        protection_rules?: { type: string; prevent_self_review?: boolean; reviewers?: unknown[] }[];
        can_admins_bypass?: boolean;
      };
      const ok = (e: Env) => {
        const r = e.protection_rules?.find((rule) => rule.type === "required_reviewers");
        return (
          r?.prevent_self_review === true &&
          (r.reviewers?.length ?? 0) > 0 &&
          e.can_admins_bypass === false
        );
      };
      const [code, publish] = await Promise.all([
        github<Env>(JACKBOY_REPO, `/repos/${JACKBOY_REPO}/environments/CODE`),
        github<Env>(JACKBOY_REPO, `/repos/${JACKBOY_REPO}/environments/CODE-PUBLISH`),
      ]);
      const bad = [!ok(code) && "CODE", !ok(publish) && "CODE-PUBLISH"].filter(Boolean);
      return bad.length
        ? {
            status: "OWNER ACTION",
            reason: `${bad.join(" and ")} must require a reviewer, block self-review and block admin bypass. Fix in GitHub → Settings → Environments.`,
          }
        : {
            status: "PASS",
            reason:
              "Both environments require a reviewer, block self-review and block admin bypass.",
          };
    }
    case "runner_isolation": {
      const [runs, main] = await Promise.all([
        github<{
          workflow_runs: {
            status: string;
            conclusion: string | null;
            head_sha: string;
            created_at: string;
          }[];
        }>(
          JACKBOY_REPO,
          `/repos/${JACKBOY_REPO}/actions/workflows/code-acceptance.yml/runs?per_page=1`,
        ),
        github<{ sha: string }>(JACKBOY_REPO, `/repos/${JACKBOY_REPO}/commits/main`),
      ]);
      const run = runs.workflow_runs[0];
      let sameTree = false;
      if (run && run.status === "completed" && run.conclusion === "success" && run.head_sha !== main.sha) {
        try {
          const [a, b] = await Promise.all(
            [run.head_sha, main.sha].map((sha) =>
              github<{ commit: { tree: { sha: string } } }>(JACKBOY_REPO, `/repos/${JACKBOY_REPO}/commits/${sha}`),
            ),
          );
          const ta = a?.commit?.tree?.sha, tb = b?.commit?.tree?.sha;
          sameTree = typeof ta === "string" && /^[a-f0-9]{40}$/.test(ta) && ta === tb;
        } catch {
          sameTree = false; // unreadable trees never count as a match
        }
      }
      return acceptanceResult(
        run
          ? {
              status: run.status,
              conclusion: run.conclusion,
              headSha: run.head_sha,
              createdAt: run.created_at,
            }
          : null,
        main.sha,
        sameTree,
      );
    }
    case "omni_prs": {
      const prs = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          github<{ merged: boolean; number: number }>(OMNI_REPO, `/repos/${OMNI_REPO}/pulls/${n}`),
        ),
      );
      const open = prs.filter((p) => !p.merged).map((p) => `#${p.number}`);
      return open.length
        ? { status: "BLOCKED", reason: `Not merged yet: ${open.join(", ")}.` }
        : { status: "PASS", reason: "OMNI pull requests #1–#4 are merged." };
    }
    case "omni_bridge": {
      const { linkConfig } = await import("./omni-session.server");
      const { reverseLinkReport, REVERSE_LINK_VARS } = await import("./omni-link-readiness");
      const { data, error } = await db
        .from("omni_link_sessions")
        .select("expires_at")
        .order("expires_at", { ascending: false })
        .limit(1);
      const rows = (data ?? []) as { expires_at: string }[];
      const report = reverseLinkReport({
      runner: (await import("./omni-runner-mode.server")).runnerMode(),
        env: Object.fromEntries(REVERSE_LINK_VARS.map((n) => [n, process.env[n]])),
        configValid: linkConfig() !== null,
        storageReady: !error && Array.isArray(data),
        lastSessionAt: rows[0]?.expires_at ?? null,
      });
      return report.verified
        ? {
            status: "PASS",
            reason:
              "OMNI has a valid link session. The live bridge itself is only proven by OMNI calling in.",
          }
        : {
            status: "BLOCKED",
            reason: `${report.missing.join("; ")}. The link stays off until OMNI_LINK_ENABLED is set and OMNI connects.`,
          };
    }
    case "deployment_identity": {
      let http = 0;
      try {
        http = (
          await fetch(PUBLISHED_URL, { redirect: "manual", signal: AbortSignal.timeout(10_000) })
        ).status;
      } catch {
        return { status: "BLOCKED", reason: "The live site did not answer within 10 seconds." };
      }
      if (http < 200 || http >= 400)
        return { status: "BLOCKED", reason: `The live site answered HTTP ${http}.` };
      const { data } = await supabaseAdmin
        .from("site_log")
        .select("at, commit_sha")
        .eq("action", "lovable_deployment_started")
        .not("commit_sha", "is", null)
        .order("at", { ascending: false })
        .limit(1);
      const record = data?.[0];
      return record?.commit_sha
        ? {
            status: "PASS",
            reason: `The live site answers (HTTP ${http}) and the newest publish record is commit ${record.commit_sha.slice(0, 7)}.`,
          }
        : {
            status: "OWNER ACTION",
            reason: `The live site answers (HTTP ${http}), but no publish record ties it to an exact commit. Publishing from the editor doesn't report the commit to Jackboy.`,
          };
    }
    case "backup_restore":
      return {
        status: "OWNER ACTION",
        reason:
          "Jackboy can't read backups. Check the newest backup time in your Cloud database settings and do a restore test there.",
      };
    case "app_least_privilege": {
      const { data } = await supabaseAdmin
        .from("github_installations")
        .select("permissions, repositories")
        .eq("revoked", false)
        .contains("repositories", [JACKBOY_REPO])
        .limit(1);
      const permissions = (data?.[0]?.permissions as Record<string, string> | undefined) ?? null;
      let selection: string | null = null;
      try {
        selection =
          (
            await github<{ repository_selection?: string }>(
              null,
              "/installation/repositories?per_page=1",
            )
          ).repository_selection ?? null;
      } catch {
        selection = null;
      }
      return appPrivilegeResult({ permissions, selection });
    }
    case "provider_gateway":
    case "physical_passkey":
      throw new Error("This check runs through its own control.");
  }
}

/** Runs one read-only check and appends its result to the site log so every page sees it. */
export async function runReadinessTest(id: ReadinessId, actor: string): Promise<ReadinessResult> {
  let result: Probe;
  try {
    result = await probe(id);
  } catch (error) {
    result = {
      status: "BLOCKED",
      reason: error instanceof Error ? error.message : "The check could not run.",
    };
  }
  return recordReadinessTest(id, result, actor);
}

export async function recordReadinessTest(
  id: ReadinessId,
  result: Probe,
  actor: string,
): Promise<ReadinessResult> {
  const name = READINESS.find((r) => r.id === id)?.name ?? id;
  await logSiteStrict({
    actor,
    action: READINESS_TEST_ACTION,
    category: "test",
    status:
      result.status === "PASS"
        ? "ok"
        : result.status === "IN PROGRESS"
          ? "pending"
          : result.status === "BLOCKED"
            ? "failed"
            : "blocked",
    summary: `${name}: ${result.status} — ${result.reason}`,
    detail: { item: id, status: result.status, reason: result.reason },
  });
  return { ...result, at: new Date().toISOString(), source: "test" };
}
