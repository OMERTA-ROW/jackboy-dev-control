import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

// Structural checks supplement (not replace) the hosted container isolation test.
export function isolationChecks(text) {
  const wf = yaml.load(text);
  const jobs = wf.jobs ?? {};
  const perms = (j) => j?.permissions ?? {};
  const body = (j) => JSON.stringify(j?.steps ?? []);
  const runsRepoCode = (j) =>
    /bun run test|bun run build|node --test|npm (run )?test|bash "\$RUNNER_TEMP\/code-validation\.sh"/.test(
      body(j).replaceAll('\\"', '"'),
    );
  const runsModel = (j) => /openai\/codex-action@/.test(body(j));
  const all = Object.entries(jobs);
  const publisher = jobs.draft_pr;
  for (const name of ["prepare", "draft_pr"]) {
    for (const step of jobs[name]?.steps ?? []) {
      const prepare = name === "prepare";
      if (
        step.id === "target_token" &&
        /^actions\/create-github-app-token@[a-f0-9]{40}$/.test(step.uses ?? "") &&
        step.if ===
          (prepare
            ? "steps.claim.outputs.target_repo != ''"
            : "needs.prepare.outputs.target_repo != ''") &&
        step.with?.owner === "OMERTA-ROW" &&
        step.with?.repositories ===
          (prepare
            ? "${{ steps.claim.outputs.target_name }}"
            : "${{ needs.prepare.outputs.target_name }}") &&
        step.with?.["permission-contents"] === (prepare ? "read" : "write") &&
        (prepare
          ? Object.keys(step.with).length === 5
          : Object.keys(step.with).length === 6 &&
            step.with["permission-pull-requests"] === "write")
      ) {
        if (step.with?.["app-id"] === "${{ secrets.CODE_APP_ID }}") delete step.with["app-id"];
        if (step.with?.["private-key"] === "${{ secrets.CODE_APP_PRIVATE_KEY }}")
          delete step.with["private-key"];
      }
    }
  }
  return {
    "no provider secret on any runner":
      !/secrets\s*(?:\.|\[)|OPENAI_API_KEY|ANTHROPIC_API_KEY|CODE_PROVIDER_API_KEY/i.test(
        JSON.stringify(wf),
      ),
    "provider reached only through the request-bound gateway":
      /\/api\/public\/code\/provider\/v1\/responses/.test(text) &&
      !/api\.openai\.com|api\.anthropic\.com/.test(text),
    "no job with OIDC identity runs repository tests/build": all.every(
      ([, j]) => !(perms(j)["id-token"] === "write" && runsRepoCode(j)),
    ),
    "tests/build run in a separate job from the model": all.every(
      ([, j]) => !(runsModel(j) && runsRepoCode(j)),
    ),
    "validation job has no write scope, OIDC or environment":
      all
        .filter(([, j]) => runsRepoCode(j))
        .every(([, j]) => !j.environment && Object.values(perms(j)).every((v) => v !== "write")) &&
      all.some(([, j]) => runsRepoCode(j)),
    "validation runs without network access":
      !!jobs.validate && /code-validation\.sh/.test(body(jobs.validate)),
    "publisher holds no model credential and runs no repository/model code":
      !!publisher &&
      !runsModel(publisher) &&
      !runsRepoCode(publisher) &&
      !/bun install|npm (ci|install)/.test(body(publisher)),
    "publisher requires the validation job":
      !!publisher && [].concat(publisher.needs ?? []).includes("validate"),
    "patch digest verified before publishing": /code-evidence\.mjs/.test(body(publisher)),
    "model job has no repository write scope": all
      .filter(([, j]) => runsModel(j))
      .every(([, j]) => perms(j).contents !== "write" && perms(j)["pull-requests"] !== "write"),
    "checkouts never persist credentials": !/persist-credentials: true/.test(text),
    "pushes only jackboy/* branches":
      /branch="jackboy\/code-\$CODE_REQUEST"/.test(text) && !/--force|push -f/.test(text),
    "opens draft PRs only, never merges":
      /gh pr create[^\n]*--draft/.test(text) && !/gh pr merge|gh pr ready|git merge/.test(text),
    "all actions pinned to full SHAs": [...text.matchAll(/^\s+(?:- )?uses:\s+(\S+)/gm)].every((m) =>
      /@[a-f0-9]{40}$/.test(m[1]),
    ),
  };
}

const active = readFileSync(new URL("../.github/workflows/code.yml", import.meta.url), "utf8");
for (const [name, ok] of Object.entries(isolationChecks(active))) {
  test(`active CODE workflow: ${name}`, () => assert.equal(ok, true));
}
test("checker rejects tests placed beside OIDC and the model", () => {
  const unsafe = active.replace("git add -N .", "bun run test\n          git add -N .");
  assert.equal(isolationChecks(unsafe)["tests/build run in a separate job from the model"], false);
});
test("checker rejects provider or misplaced App secrets", () => {
  for (const unsafe of [
    active.replace("secrets.CODE_APP_PRIVATE_KEY", "secrets.OPENAI_API_KEY"),
    active.replace(
      "git add -N .",
      "echo '${{ secrets.CODE_APP_PRIVATE_KEY }}'\n          git add -N .",
    ),
    active.replace("git add -N .", "echo \"${{ secrets['OTHER'] }}\"\n          git add -N ."),
    active.replace("id: target_token", "id: another_token"),
    active.replace("permission-contents: read", "permission-contents: write"),
    active.replace("repositories: ${{ steps.claim.outputs.target_name }}", "repositories: other"),
  ]) {
    assert.equal(isolationChecks(unsafe)["no provider secret on any runner"], false);
  }
});
