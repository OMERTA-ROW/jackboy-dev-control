// Build identity: which source commit a running site was built from.
// The values are stamped at build time by vite.config.ts (git metadata of the workspace that
// built it). A build without git metadata reports nulls — never a guessed commit.

export type BuildInfo = {
  commit: string | null;
  tree: string | null;
  dirty: boolean | null;
  builtAt: string | null;
};

declare const __JACKBOY_BUILD__: unknown;

const SHA = /^[0-9a-f]{40}$/;

export function parseBuildInfo(raw: unknown): BuildInfo {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sha = (v: unknown) => (typeof v === "string" && SHA.test(v) ? v : null);
  const builtAt =
    typeof o["builtAt"] === "string" && !Number.isNaN(Date.parse(o["builtAt"] as string))
      ? (o["builtAt"] as string)
      : null;
  return {
    commit: sha(o["commit"]),
    tree: sha(o["tree"]),
    dirty: typeof o["dirty"] === "boolean" ? (o["dirty"] as boolean) : null,
    builtAt,
  };
}

export function currentBuild(): BuildInfo {
  return parseBuildInfo(typeof __JACKBOY_BUILD__ === "undefined" ? null : __JACKBOY_BUILD__);
}

export type DeploymentVerdict = { status: "PASS" | "BLOCKED"; reason: string };

/**
 * Compare what the live site says it was built from with GitHub main.
 * Same commit, or same file tree (merge commits with identical files), counts as in sync —
 * but only when the build had no uncommitted changes.
 */
export function deploymentVerdict(
  live: BuildInfo,
  main: { commit: string; tree: string | null } | null,
): DeploymentVerdict {
  if (!live.commit)
    return {
      status: "BLOCKED",
      reason:
        "The live site reports no build commit (the build had no git details), so the deployed version can't be proven.",
    };
  const short = live.commit.slice(0, 7);
  if (live.dirty !== false)
    return {
      status: "BLOCKED",
      reason: `The live site was built from ${short}${live.dirty ? " plus unsaved changes" : " but didn't say whether it had unsaved changes"}, so it can't be tied to an exact commit.`,
    };
  if (!main)
    return {
      status: "BLOCKED",
      reason: `The live site is ${short}, but GitHub main couldn't be read to compare.`,
    };
  if (live.commit === main.commit)
    return { status: "PASS", reason: `The live site is built from GitHub main (${short}).` };
  if (live.tree && main.tree && live.tree === main.tree)
    return {
      status: "PASS",
      reason: `The live site is ${short}; its files are identical to GitHub main (${main.commit.slice(0, 7)}).`,
    };
  return {
    status: "BLOCKED",
    reason: `The live site is ${short}, but GitHub main is ${main.commit.slice(0, 7)} with different files. Publish again once main is the version you want live.`,
  };
}
