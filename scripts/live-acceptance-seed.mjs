// Generates the contents of a DISPOSABLE CODE acceptance repository into a local directory.
// It never creates a repository, calls GitHub, reads secrets or contacts a model provider.
// The workflow is derived from the production code.yml so the claim/publish/finish gates are the
// real ones; only the paid model step and the Bun/Jackboy build steps are replaced.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CODEX_STEP =
  /      - name: Codex prepares the scoped change\n(?:        .*\n|\n)+?(?=      - name: Capture model patch)/;
const BUN_STEPS =
  /      - uses: oven-sh\/setup-bun@[0-9a-f]{40}\n        with:\n          bun-version: "[^"]+"\n/;
const INSTALL_STEP =
  "      - name: Install dependencies without lifecycle scripts\n        run: bun install --frozen-lockfile --ignore-scripts\n";

const DETERMINISTIC_STEP = `      - name: Deterministic stand-in for the model step (no provider call)
        env:
          INSTRUCTION: \${{ steps.claim.outputs.instruction }}
          RUN_ID: \${{ github.run_id }}
        run: |
          node --input-type=module <<'NODE'
          import { mkdirSync, writeFileSync } from 'node:fs';
          import { createHash } from 'node:crypto';
          const digest = createHash('sha256').update(process.env.INSTRUCTION).digest('hex');
          mkdirSync('docs/acceptance', { recursive: true });
          writeFileSync(\`docs/acceptance/touch-\${process.env.RUN_ID}.md\`, \`Acceptance marker for instruction \${digest}.\\n\`);
          writeFileSync(process.env.RUNNER_TEMP + '/code-report.md', 'Deterministic acceptance run. No model was called.\\n');
          NODE
`;

const stepBlock = (name) => new RegExp(`      - name: ${name}\\n(?:        .*\\n|\\n)+`);
const GITHUB_ONLY_BANNER =
  "# GITHUB-ONLY PLUMBING MODE. The Jackboy claim/finish calls are removed. This is NOT the production gate.\n";

export function deriveWorkflow(source, { githubOnly = false } = {}) {
  const gatewayStep = stepBlock("Bind gateway access to this approved request");
  if (
    !CODEX_STEP.test(source) ||
    !BUN_STEPS.test(source) ||
    !gatewayStep.test(source) ||
    !source.includes(INSTALL_STEP) ||
    !source.includes('run: bash "$RUNNER_TEMP/code-validation.sh"') ||
    !source.includes("gh attestation verify")
  ) {
    throw new Error("code.yml changed: update the acceptance seed derivation and review it.");
  }
  let out = source
    .replace(CODEX_STEP, DETERMINISTIC_STEP)
    .replace(gatewayStep, "")
    .replace(BUN_STEPS, "")
    .replace(INSTALL_STEP, "");
  if (githubOnly) {
    out = out
      .replace(
        stepBlock("Claim approved request"),
        '      - name: Claim approved request (GITHUB-ONLY MODE, no Jackboy backend)\n        id: claim\n        run: echo "instruction=github-only plumbing test" >> "$GITHUB_OUTPUT"\n',
      )
      .replace(
        stepBlock("Claim independent publishing authorization"),
        '      - name: Publishing authorization (GITHUB-ONLY MODE, no Jackboy backend)\n        run: echo "github-only plumbing test"\n',
      )
      .replace(
        stepBlock("Record the final task outcome"),
        '      - name: Record the final task outcome (GITHUB-ONLY MODE)\n        run: echo "no backend call"\n',
      );
    out = GITHUB_ONLY_BANNER + out;
    if (/CODE_RUNNER_AUTH_URL|ACTIONS_ID_TOKEN_REQUEST|fetch\(/.test(out)) {
      throw new Error("GitHub-only workflow still references the Jackboy backend.");
    }
  }
  if (/OPENAI|codex-action|setup-bun|bun /.test(out)) {
    throw new Error("Derived workflow still references a provider or Bun.");
  }
  return out;
}

export function seedFiles(repoRoot = root, options = {}) {
  const workflow = deriveWorkflow(
    readFileSync(join(repoRoot, ".github/workflows/code.yml"), "utf8"),
    options,
  );
  const gate = readFileSync(join(repoRoot, "scripts/code-patch.mjs"), "utf8");
  const sandbox = readFileSync(join(repoRoot, "scripts/code-validation.sh"), "utf8")
    .replace('  --mount "type=bind,src=$(command -v bun),dst=/usr/local/bin/bun,readonly" \\\n', "")
    .replace("    bun run test\n", "    node --test tests/\n")
    .replace(
      "    node --test tests/code-contract.test.mjs tests/code-security.test.mjs tests/code-runtime.test.mjs tests/code-patch.test.mjs\n",
      "",
    )
    .replace("    bun x --no-install tsc --noEmit --strict\n", "")
    .replace("    bun run build\n", "");
  if (/\bbun\b/.test(sandbox)) throw new Error("Acceptance sandbox derivation drifted.");
  return {
    ".github/workflows/code.yml": workflow,
    "scripts/code-patch.mjs": gate,
    "scripts/code-evidence.mjs": readFileSync(join(repoRoot, "scripts/code-evidence.mjs"), "utf8"),
    "scripts/code-validation.sh": sandbox,
    "package.json":
      JSON.stringify(
        { name: "jackboy-code-acceptance-seed", private: true, type: "module" },
        null,
        2,
      ) + "\n",
    "tests/seed.test.mjs":
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('seed repository is intact', () => assert.equal(1 + 1, 2));\n",
    "README.md":
      "# Jackboy CODE acceptance seed (disposable)\n\nThis repository exists only to test CODE gating. It holds no production code, secrets or customers' data. Delete it after acceptance.\n",
    "docs/acceptance/.gitkeep": "",
  };
}

export function seedManifest(files) {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      createHash("sha256").update(text).digest("hex"),
    ]),
  );
}

export function writeSeed(target, repoRoot = root, options = {}) {
  const files = seedFiles(repoRoot, options);
  for (const [path, text] of Object.entries(files)) {
    const full = join(resolve(target), path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return seedManifest(files);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2])
    throw new Error("Usage: node scripts/live-acceptance-seed.mjs <empty local directory>");
  console.log(
    JSON.stringify(
      writeSeed(process.argv[2], root, { githubOnly: process.argv.includes("--github-only") }),
      null,
      2,
    ),
  );
}
