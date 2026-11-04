import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWorkflow, seedFiles, writeSeed } from "../scripts/live-acceptance-seed.mjs";

const prod = readFileSync(new URL("../.github/workflows/code.yml", import.meta.url), "utf8");
const derived = deriveWorkflow(prod);
const sh = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: tmpdir(), ...env },
  });

test("derived workflow keeps every production gate and removes only the paid model step", () => {
  for (const kept of [
    "environment: CODE\n",
    "environment: CODE-PUBLISH\n",
    "stage: 'execute'",
    "stage: 'publish'",
    "/api/public/code/finish",
    "vars.CODE_RUNNER_AUTH_URL",
    "--draft",
    'branch="jackboy/code-$CODE_REQUEST"',
    "node scripts/code-patch.mjs",
    "node scripts/code-evidence.mjs",
    "gh attestation verify",
    "needs: [prepare, validate]",
    'run: bash "$RUNNER_TEMP/code-validation.sh"',
    "id-token: write",
  ]) {
    assert.ok(prod.includes(kept) && derived.includes(kept), `missing ${kept}`);
  }
  assert.equal(/secrets\./.test(derived), false, "no secret may be referenced");
  assert.equal(/openai|codex-action|setup-bun|\bbun /i.test(derived), false);
  assert.doesNotMatch(derived, /steps\.gateway|\/code\/provider|name: Bind gateway/);
  assert.equal(/gh pr merge|--auto|workflow_run|schedule:|cron:/.test(derived), false);
  assert.match(derived, /workflow_dispatch:/);
  assert.equal(derived.match(/git .*push /g)?.length, 1);
  assert.ok(derived.includes("HEAD:refs/heads/$branch"));
});

test("derivation fails closed when production code.yml drifts", () => {
  assert.throws(
    () =>
      deriveWorkflow(
        prod.replace("Bind gateway access to this approved request", "Unknown gateway"),
      ),
    /code\.yml changed/,
  );
  assert.throws(
    () => deriveWorkflow(prod.replace("Codex prepares the scoped change", "Something else")),
    /code\.yml changed/,
  );
  assert.throws(
    () => deriveWorkflow(prod.replace("bun install --frozen-lockfile", "bun install")),
    /code\.yml changed/,
  );
});

test("seed is self-contained, matches the real patch gate byte-for-byte and references no production data", () => {
  const files = seedFiles();
  assert.equal(
    files["scripts/code-patch.mjs"],
    readFileSync(new URL("../scripts/code-patch.mjs", import.meta.url), "utf8"),
  );
  assert.equal(
    files["scripts/code-evidence.mjs"],
    readFileSync(new URL("../scripts/code-evidence.mjs", import.meta.url), "utf8"),
  );
  assert.match(files["scripts/code-validation.sh"], /--network none/);
  assert.match(files["scripts/code-validation.sh"], /--read-only --cap-drop ALL/);
  assert.match(files["scripts/code-validation.sh"], /node --test tests\//);
  assert.equal(
    Object.keys(files).some((p) => /^\.env|drizzle|src\//.test(p)),
    false,
  );
  assert.equal(
    /supabase\.co|sb_publishable|lovable\.app|SUPABASE_[A-Z_]*=/i.test(
      Object.values(files).join("\n"),
    ),
    false,
  );
});

test("deterministic stand-in produces a patch the real gate accepts, and the gate still rejects protected paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  try {
    writeSeed(dir);
    sh("git", ["init", "-q", "-b", "main"], dir);
    sh("git", ["add", "-A"], dir);
    sh("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], dir);
    const step = derived
      .split("- name: Deterministic stand-in")[1]
      .split("<<'NODE'\n")[1]
      .split("\n          NODE")[0];
    const script = step.replace(/^ {10}/gm, "");
    const temp = mkdtempSync(join(tmpdir(), "seed-tmp-"));
    sh("node", ["--input-type=module", "-e", script], dir, {
      INSTRUCTION: "harmless acceptance task; $(touch /tmp/pwned) `id`",
      RUN_ID: "123",
      RUNNER_TEMP: temp,
    });
    assert.equal(existsSync("/tmp/pwned"), false, "instruction must be data, never shell");
    assert.match(readFileSync(join(temp, "code-report.md"), "utf8"), /No model was called/);
    sh("git", ["add", "-N", "."], dir);
    const patch = join(temp, "code.patch");
    writeFileSync(patch, sh("git", ["diff", "--binary", "HEAD"], dir));
    const pristine = join(temp, "pristine");
    sh("git", ["clone", "-q", dir, pristine], temp);
    sh("node", ["scripts/code-patch.mjs", patch], pristine);

    writeFileSync(join(dir, ".github/workflows/evil.yml"), "on: push\n");
    sh("git", ["add", "-N", "."], dir);
    writeFileSync(patch, sh("git", ["diff", "--binary", "HEAD"], dir));
    assert.throws(
      () => sh("node", ["scripts/code-patch.mjs", patch], pristine),
      /protected or invalid patch path/,
    );
    rmSync(temp, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHub-only mode removes every backend call but keeps environments, draft-only publishing and no secrets", () => {
  const only = seedFiles(undefined, { githubOnly: true })[".github/workflows/code.yml"];
  assert.equal(only, deriveWorkflow(prod, { githubOnly: true }));
  assert.notEqual(only, seedFiles()[".github/workflows/code.yml"]);
  assert.match(only, /^# GITHUB-ONLY PLUMBING MODE/);
  assert.equal(/CODE_RUNNER_AUTH_URL|ACTIONS_ID_TOKEN_REQUEST|fetch\(|secrets\./.test(only), false);
  for (const kept of [
    "environment: CODE\n",
    "environment: CODE-PUBLISH\n",
    "--draft",
    "HEAD:refs/heads/$branch",
    "node scripts/code-patch.mjs",
  ]) {
    assert.ok(only.includes(kept), `missing ${kept}`);
  }
  assert.equal(only.match(/git .*push /g)?.length, 1);
});
