import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { safeCodePath, validateCodePatch } from "../scripts/code-patch.mjs";
test("publisher gate refuses credentials, workflows, auth, migrations, CODE and path escapes", () => {
  for (const p of [
    ".env",
    ".github/workflows/evil.yml",
    ".GITHUB/workflows/evil.yml",
    "nested/.github/workflows/evil.yml",
    "src/auth.ts",
    "src/lib/passkey.server.ts",
    "supabase/config.toml",
    "drizzle/migrations/a.sql",
    "scripts/code-patch.mjs",
    "src/lib/code.server.ts",
    "package.json",
    "../a",
    "src/../.github/workflows/evil.yml",
    "a\\b",
    "file with spaces",
    '"a/.github/workflows/evil.yml"',
  ])
    assert.equal(safeCodePath(p), false, p);
  assert.equal(safeCodePath("src/components/Footer.tsx"), true);
});
test("real git patch is checked against a pristine checkout; symlink and protected patch refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "code-patch-"));
  const git = async (...args) => (await exec("git", args, { cwd: dir, encoding: "utf8" })).stdout;
  try {
    await git("init", "-q");
    writeFileSync(join(dir, "hello.txt"), "before\n");
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "base");
    writeFileSync(join(dir, "hello.txt"), "after\n");
    const patch = await git("diff");
    await git("checkout", "--", "hello.txt");
    const file = join(dir, "change.patch");
    writeFileSync(file, patch);
    assert.equal(await validateCodePatch(file, dir), 1);
    writeFileSync(file, patch.replaceAll("hello.txt", ".env"));
    await assert.rejects(() => validateCodePatch(file, dir), /protected/);
    writeFileSync(file, patch + "\nnew file mode 120000\n");
    await assert.rejects(() => validateCodePatch(file, dir), /symlinks/);
    writeFileSync(file, "");
    await assert.rejects(() => validateCodePatch(file, dir), /no diff/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "code-patch-"));
  const git = async (...args) => (await exec("git", args, { cwd: dir, encoding: "utf8" })).stdout;
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, "src/components"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/build.yml"), "name: build\n");
  writeFileSync(join(dir, "src/components/footer.tsx"), "export const Footer = 1;\n");
  writeFileSync(join(dir, "src/components/promote.tsx"), "export const Promote = 1;\n");
  await git("init", "-q");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "base");
  return { dir, git };
}

test("real patch gate permits ordinary additions, edits and deletions", async () => {
  const scenarios = [
    async ({ dir, git }) => {
      writeFileSync(join(dir, "src/components/footer.tsx"), "export const Footer = 2;\n");
      return git("diff", "--binary");
    },
    async ({ dir, git }) => {
      writeFileSync(join(dir, "src/components/added.tsx"), "export const Added = true;\n");
      await git("add", "-N", "--", "src/components/added.tsx");
      return git("diff", "--binary");
    },
    async ({ dir, git }) => {
      rmSync(join(dir, "src/components/footer.tsx"));
      return git("diff", "--binary");
    },
  ];
  for (const change of scenarios) {
    const target = await createRepo(),
      source = await createRepo();
    const patchDir = mkdtempSync(join(tmpdir(), "code-patch-file-"));
    try {
      const patchFile = join(patchDir, "change.patch");
      writeFileSync(patchFile, await change(source));
      assert.equal(await validateCodePatch(patchFile, target.dir), 1);
      assert.equal(await target.git("status", "--porcelain"), "");
    } finally {
      rmSync(target.dir, { recursive: true, force: true });
      rmSync(source.dir, { recursive: true, force: true });
      rmSync(patchDir, { recursive: true, force: true });
    }
  }
});

test("real patch gate rejects workflow additions, edits, deletions and renames before applying", async () => {
  const scenarios = [
    async ({ dir, git }) => {
      writeFileSync(join(dir, ".github/workflows/build.yml"), "name: modified\n");
      return git("diff", "--binary");
    },
    async ({ dir, git }) => {
      writeFileSync(join(dir, ".github/workflows/extra.yml"), "name: extra\n");
      await git("add", "-N", "--", ".github/workflows/extra.yml");
      return git("diff", "--binary");
    },
    async ({ dir, git }) => {
      rmSync(join(dir, ".github/workflows/build.yml"));
      return git("diff", "--binary");
    },
    async ({ dir, git }) => {
      await git("mv", ".github/workflows/build.yml", "src/components/build.yml");
      await git("add", "-A");
      return git("diff", "--cached", "--binary", "--find-renames");
    },
    async ({ dir, git }) => {
      await git("mv", "src/components/promote.tsx", ".github/workflows/promote.yml");
      await git("add", "-A");
      return git("diff", "--cached", "--binary", "--find-renames");
    },
  ];
  for (const change of scenarios) {
    const target = await createRepo(),
      source = await createRepo();
    const patchDir = mkdtempSync(join(tmpdir(), "code-patch-file-"));
    try {
      const patchFile = join(patchDir, "change.patch");
      writeFileSync(patchFile, await change(source));
      await assert.rejects(
        () => validateCodePatch(patchFile, target.dir),
        /protected or invalid patch path/,
      );
      assert.equal(await target.git("status", "--porcelain"), "");
    } finally {
      rmSync(target.dir, { recursive: true, force: true });
      rmSync(source.dir, { recursive: true, force: true });
      rmSync(patchDir, { recursive: true, force: true });
    }
  }
});

test("patch gate rejects traversal and quoted path headers before git parses them", async () => {
  const { dir, git } = await createRepo();
  const patchDir = mkdtempSync(join(tmpdir(), "code-patch-file-"));
  try {
    const patchFile = join(patchDir, "change.patch");
    const patches = [
      "diff --git a/../.github/workflows/evil.yml b/src/components/footer.tsx\n--- a/../.github/workflows/evil.yml\n+++ b/src/components/footer.tsx\n",
      'diff --git "a/.github/workflows/evil.yml" "b/src/components/footer.tsx"\n--- "a/.github/workflows/evil.yml"\n+++ "b/src/components/footer.tsx"\n',
      'diff --git a/src/components/footer.tsx b/src/components/footer.tsx\nrename from ".github/workflows/evil.yml"\nrename to src/components/footer.tsx\n',
    ];
    for (const patch of patches) {
      writeFileSync(patchFile, patch);
      await assert.rejects(() => validateCodePatch(patchFile, dir), /invalid|ambiguous|protected/);
      assert.equal(await git("status", "--porcelain"), "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(patchDir, { recursive: true, force: true });
  }
});

test("patch gate rejects an ordinary-looking path that traverses a workflow symlink", async () => {
  const { dir } = await createRepo();
  const patchDir = mkdtempSync(join(tmpdir(), "code-patch-file-"));
  try {
    symlinkSync(".github/workflows", join(dir, "workflow-alias"));
    const patchFile = join(patchDir, "change.patch");
    writeFileSync(
      patchFile,
      [
        "diff --git a/workflow-alias/build.yml b/workflow-alias/build.yml",
        "--- a/workflow-alias/build.yml",
        "+++ b/workflow-alias/build.yml",
        "@@ -1 +1 @@",
        "-name: build",
        "+name: modified",
        "",
      ].join("\n"),
    );
    await assert.rejects(() => validateCodePatch(patchFile, dir), /symbolic link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(patchDir, { recursive: true, force: true });
  }
});
