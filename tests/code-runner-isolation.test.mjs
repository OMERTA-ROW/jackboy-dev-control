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
  return {
    "no provider secret on any runner":
      !/secrets\.|OPENAI_API_KEY|ANTHROPIC_API_KEY|CODE_PROVIDER_API_KEY/.test(text),
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
