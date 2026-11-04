import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) =>
  readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");

test("full acceptance initializes disposable PostgreSQL inside provider-isolated tests", () => {
  const workflow = read("code-acceptance.yml");
  assert.match(workflow, /STAGING_PG_URL=postgres:\/\/stg@127\.0\.0\.1:54329\/postgres/);
  assert.match(workflow, /STAGING_PG_MODULE_FROM=.*acceptance-pg-driver\/package\.json/);
  assert.match(workflow, /unshare -n bash -euo pipefail/);
  assert.match(workflow, /runuser -u runner -- "\$PG_BIN\/initdb"/);
  assert.match(workflow, /trap .*pg_ctl.*stop/);
  assert.match(workflow, /runuser -u runner -- timeout 300 node --test --test-concurrency=1/);
  assert.match(workflow, /grep -E '\^ℹ skipped \[1-9\]'/);
  assert.doesNotMatch(workflow, /paths:|paths-ignore:/);
  assert.doesNotMatch(workflow, /secrets\.|environment:|contents: write|workflow_run:/);
});

test("TypeScript gates are strict and failures cannot be ignored", () => {
  const verify = read("verify.yml");
  const checks = read("jackboy-checks.yml");
  assert.match(verify, /workflow_dispatch:/);
  assert.match(verify, /typescript:/);
  for (const workflow of [verify, checks]) {
    assert.match(workflow, /bunx tsc --noEmit --strict/);
    assert.doesNotMatch(workflow, /tsc[^\n]*\|\||continue-on-error: true/);
  }
});
