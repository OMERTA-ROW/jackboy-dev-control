import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { verifyCodeEvidence } from "../scripts/code-evidence.mjs";

test("patch evidence rejects absent, modified, symlinked and oversized artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "code-evidence-"));
  try {
    const file = join(dir, "code.patch");
    const patch = "diff --git a/a b/a\n";
    writeFileSync(file, patch);
    const expected = createHash("sha256").update(patch).digest("hex");
    verifyCodeEvidence(file, expected);
    assert.throws(() => verifyCodeEvidence(file, undefined), /trusted/);
    writeFileSync(file, `${patch}tampered`);
    assert.throws(() => verifyCodeEvidence(file, expected), /does not match/);
    const link = join(dir, "link");
    symlinkSync(file, link);
    assert.throws(() => verifyCodeEvidence(link, expected), /Invalid/);
    writeFileSync(file, "x".repeat(500_001));
    assert.throws(() => verifyCodeEvidence(file, expected), /Invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publisher authenticates original signed patch, not mutable validator outputs", () => {
  const { jobs } = yaml.load(readFileSync(".github/workflows/code.yml", "utf8"));
  for (const stage of ["validate", "draft_pr"]) {
    const text = JSON.stringify(jobs[stage]);
    assert.match(text, /needs\.prepare\.outputs\.artifact_id/);
    assert.match(text, /needs\.prepare\.outputs\.patch_sha256/);
    assert.match(text, /gh attestation verify/);
    for (const flag of [
      "--signer-workflow",
      "--source-digest",
      "--signer-digest",
      "--source-ref",
      "--deny-self-hosted-runners",
    ])
      assert.ok(text.includes(flag));
    assert.doesNotMatch(text, /needs\.validate\.outputs|code\.patch\.sha256/);
  }
  assert.ok(JSON.stringify(jobs.prepare).includes("actions/attest-build-provenance@"));
  assert.equal(jobs.validate.permissions["id-token"], undefined);
  assert.equal(jobs.validate.environment, undefined);
  assert.ok(JSON.stringify(jobs.prepare).includes("features.shell_tool=false"));
  assert.ok(JSON.stringify(jobs.prepare).includes("features.unified_exec=false"));
  assert.doesNotMatch(JSON.stringify(jobs.prepare), /bun install|bun run test|bun run build/);
});

test("untrusted validation has no writable host mount, network, Docker socket or job identity", () => {
  const script = readFileSync("scripts/code-validation.sh", "utf8");
  for (const flag of [
    "--network none",
    "--read-only",
    "--cap-drop ALL",
    "--security-opt no-new-privileges",
    "--user 1000:1000",
    "--pids-limit",
    "--memory",
    "--cpus",
    "--tmpfs",
    "--init",
  ])
    assert.ok(script.includes(flag), flag);
  assert.match(script, /node:26-bookworm@sha256:[a-f0-9]{64}/);
  assert.match(script, /src=\$PWD,dst=\/source,readonly/);
  assert.doesNotMatch(
    script,
    /--privileged|--pid host|--network host|--env-file|--env (GH|GITHUB|ACTIONS|.*TOKEN)|dst=\/var\/run\/docker.sock/,
  );
  assert.match(script, /trap .*docker rm -f/);
});
