// Pure rules for the live readiness checks. Every status comes from a real read (a recorded Test or
// a live observation of the feature being used). Nothing here grants activation or changes state.

export type ReadinessStatus = "PASS" | "BLOCKED" | "NOT TESTED" | "OWNER ACTION" | "IN PROGRESS";

export type ReadinessId =
  | "code_runtime"
  | "spend_enforcement"
  | "provider_gateway"
  | "workflow_pins"
  | "reviewer_gates"
  | "runner_isolation"
  | "physical_passkey"
  | "omni_prs"
  | "omni_bridge"
  | "deployment_identity"
  | "backup_restore"
  | "app_least_privilege";

/** Owner controls that already exist elsewhere and keep their own passkey gates. */
export type ReadinessControl = "emergency_stop" | "start_activation" | "passkey_test";

export type ReadinessDef = {
  id: ReadinessId;
  name: string;
  what: string;
  /** Present only when an existing, passkey-gated control can block or unblock it. */
  block?: ReadinessControl;
  unblock?: ReadinessControl;
  /** The Test is a real device passkey check instead of a server read. */
  test?: "server" | "passkey";
};

export const READINESS: ReadinessDef[] = [
  {
    id: "code_runtime",
    name: "CODE on/off controls",
    what: "Reads whether CODE is on and whether its emergency stop is engaged.",
    block: "emergency_stop",
    unblock: "start_activation",
  },
  {
    id: "spend_enforcement",
    name: "Spending limits enforced",
    what: "Reads the $10 total guard, the live spending meter and your hard-cap confirmation.",
    unblock: "start_activation",
  },
  {
    id: "provider_gateway",
    name: "Provider gateway",
    what: "Checks the gateway settings and asks OpenAI whether the key can see the chosen model. This read is free; no model is run.",
  },
  {
    id: "workflow_pins",
    name: "Workflow version pins",
    what: "Compares the workflow file on GitHub main with the saved CODE_TARGETS and database pins.",
  },
  {
    id: "reviewer_gates",
    name: "GitHub reviewer gates",
    what: "Reads the CODE and CODE-PUBLISH environments: reviewers required, no self-review, no admin bypass.",
  },
  {
    id: "runner_isolation",
    name: "Runner isolation acceptance",
    what: "Reads the latest CODE acceptance run (hosted runner, no secrets, no network to paid providers) and compares it with current main.",
  },
  {
    id: "physical_passkey",
    name: "Physical-device passkey",
    what: "A real passkey check on your device. Counts only on the live site.",
    test: "passkey",
  },
  {
    id: "omni_prs",
    name: "OMNI pull requests",
    what: "Reads OMNI pull requests #1–#4 on GitHub and checks they are merged.",
  },
  {
    id: "omni_bridge",
    name: "OMNI HTTPS bridge",
    what: "Reads the OMNI link settings, storage and the newest OMNI session. Jackboy never calls OMNI here.",
  },
  {
    id: "deployment_identity",
    name: "Published deployment",
    what: "Loads the live site and looks for a publish record that ties it to an exact commit.",
  },
  {
    id: "backup_restore",
    name: "Backup and restore",
    what: "Backups are not readable from inside Jackboy, so this needs your own check.",
  },
  {
    id: "app_least_privilege",
    name: "GitHub App least privilege",
    what: "Reads the GitHub App's live repository access and saved permissions.",
  },
];

export type ReadinessResult = {
  status: ReadinessStatus;
  reason: string;
  at: string;
  source: "test" | "live";
};
export type StoredTest = { item: string; status: ReadinessStatus; reason: string; at: string };

const STATUSES: ReadinessStatus[] = [
  "PASS",
  "BLOCKED",
  "NOT TESTED",
  "OWNER ACTION",
  "IN PROGRESS",
];

/** Parses a stored site-log test row; anything malformed is ignored rather than trusted. */
export function parseStoredTest(row: { at: string; detail: unknown }): StoredTest | null {
  const d = row.detail as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return null;
  const item = d["item"],
    status = d["status"],
    reason = d["reason"];
  if (
    typeof item !== "string" ||
    typeof reason !== "string" ||
    !STATUSES.includes(status as ReadinessStatus)
  )
    return null;
  if (!READINESS.some((r) => r.id === item)) return null;
  return { item, status: status as ReadinessStatus, reason, at: row.at };
}

/** Newest evidence wins: a live observation newer than the last Test replaces it, and vice versa. */
export function combine(
  test: StoredTest | undefined,
  live: ReadinessResult | null,
): ReadinessResult {
  const fromTest: ReadinessResult | null = test
    ? { status: test.status, reason: test.reason, at: test.at, source: "test" }
    : null;
  if (live && (!fromTest || Date.parse(live.at) >= Date.parse(fromTest.at))) return live;
  if (fromTest) return fromTest;
  return {
    status: "NOT TESTED",
    reason: "No test or live use recorded yet. Press Test.",
    at: "",
    source: "test",
  };
}

export function latestTests(rows: { at: string; detail: unknown }[]): Map<string, StoredTest> {
  const out = new Map<string, StoredTest>();
  for (const row of rows) {
    const t = parseStoredTest(row);
    if (t && (!out.has(t.item) || Date.parse(t.at) > Date.parse(out.get(t.item)!.at)))
      out.set(t.item, t);
  }
  return out;
}

export const PUBLISHED_RP_ID = "jackboy-dev-control.lovable.app";

/** A passkey confirmation counts as a physical-device check only on the published site. */
export function passkeyObservation(
  uses: { at: string; rpId: string | null; action: string }[],
): ReadinessResult | null {
  const live = uses
    .filter((u) => u.rpId === PUBLISHED_RP_ID)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!live) return null;
  return {
    status: "PASS",
    reason: `Passkey confirmed on the live site for "${live.action}".`,
    at: live.at,
    source: "live",
  };
}

/** A settled gateway call is real proof the gateway works end to end. */
export function gatewayObservation(
  call: { finishedAt: string | null; status: string; model: string } | null,
): ReadinessResult | null {
  if (!call?.finishedAt) return null;
  if (call.status === "settled")
    return {
      status: "PASS",
      reason: `The gateway completed a real ${call.model} call.`,
      at: call.finishedAt,
      source: "live",
    };
  if (call.status === "unknown")
    return {
      status: "BLOCKED",
      reason: "The last gateway call ended with an unknown result; spending was held.",
      at: call.finishedAt,
      source: "live",
    };
  return null;
}

export function runtimeObservation(
  c: { enabled: boolean; killSwitch: boolean } | null,
  at: string,
): ReadinessResult {
  if (!c)
    return {
      status: "BLOCKED",
      reason: "CODE controls could not be read, so CODE stays blocked.",
      at,
      source: "live",
    };
  const on = c.enabled && !c.killSwitch;
  return {
    status: "PASS",
    reason: on
      ? "CODE is ON and its emergency stop is released. Each run still needs your GitHub approval."
      : `CODE is off; emergency stop ${c.killSwitch ? "engaged" : "released"}.`,
    at,
    source: "live",
  };
}

export function spendObservation(
  s: { guardOk: boolean; meterOk: boolean; hardCap: boolean; reasons: string[] },
  at: string,
): ReadinessResult {
  const missing = [
    !s.guardOk && "the $10 total guard is not enforced",
    !s.meterOk && "the live spending meter is not healthy",
    !s.hardCap && "the provider hard cap is not marked verified",
  ].filter(Boolean) as string[];
  if (!missing.length)
    return {
      status: "PASS",
      reason:
        "The $10 guard is enforced, the meter is healthy and your hard cap is marked verified.",
      at,
      source: "live",
    };
  return {
    status: s.hardCap || !s.guardOk || !s.meterOk ? "BLOCKED" : "OWNER ACTION",
    reason: `Blocked: ${missing.join("; ")}${s.reasons.length ? ` (${s.reasons.join("; ")})` : ""}.`,
    at,
    source: "live",
  };
}

export function omniSessionObservation(
  expiresAt: string | null,
  now: number,
): ReadinessResult | null {
  if (!expiresAt || Date.parse(expiresAt) <= now) return null;
  return {
    status: "PASS",
    reason: "OMNI opened a verified link session that is still valid.",
    at: new Date(now).toISOString(),
    source: "live",
  };
}

export function acceptanceResult(
  run: { conclusion: string | null; status: string; headSha: string; createdAt: string } | null,
  mainSha: string | null,
  /** True only when GitHub reports the run's commit and current main have the identical file tree. */
  sameTreeAsMain = false,
): Omit<ReadinessResult, "at" | "source"> {
  if (!run)
    return {
      status: "NOT TESTED",
      reason:
        "No CODE acceptance run found on GitHub. Run it from GitHub → Actions → CODE acceptance.",
    };
  if (run.status !== "completed")
    return {
      status: "IN PROGRESS",
      reason: "A CODE acceptance run is still going. Press Test again when it finishes.",
    };
  if (run.conclusion !== "success")
    return {
      status: "BLOCKED",
      reason: `The latest CODE acceptance run ended "${run.conclusion ?? "unknown"}". Open it in GitHub Actions to see which check failed.`,
    };
  if (mainSha && run.headSha !== mainSha && sameTreeAsMain)
    // A merge commit with no file changes of its own: the tested files are exactly main's files.
    return {
      status: "PASS",
      reason: `CODE acceptance passed on commit ${run.headSha.slice(0, 7)}, whose files are identical to current main ${mainSha.slice(0, 7)}.`,
    };
  if (!mainSha || run.headSha !== mainSha)
    return {
      status: "OWNER ACTION",
      reason: `The last passing run was for commit ${run.headSha.slice(0, 7)}, not current main${mainSha ? ` ${mainSha.slice(0, 7)}` : ""}. Run CODE acceptance on main in GitHub Actions, then press Test.`,
    };
  return {
    status: "PASS",
    reason: `CODE acceptance passed on current main ${mainSha.slice(0, 7)}.`,
  };
}

export function appPrivilegeResult(p: {
  permissions: Record<string, string> | null;
  selection: string | null;
}): Omit<ReadinessResult, "at" | "source"> {
  if (!p.permissions)
    return { status: "BLOCKED", reason: "No GitHub App installation is recorded for Jackboy." };
  const extra = [
    p.permissions["workflows"] === "write" && "workflow write access",
    p.selection === "all" && "access to all repositories",
  ].filter(Boolean) as string[];
  if (!p.selection) extra.push("repository selection could not be read");
  if (!extra.length)
    return {
      status: "PASS",
      reason: "The App has selected repositories only and no workflow write access.",
    };
  return {
    status: "OWNER ACTION",
    reason: `More access than needed: ${extra.join(", ")}. Reduce it in GitHub → Settings → GitHub Apps → Configure, then press Test.`,
  };
}
