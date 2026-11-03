import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/code.yml", import.meta.url), "utf8");
const prepare = workflow.match(/^  prepare:\n([\s\S]*?)^  draft_pr:/m)?.[1] ?? "";
const publisher = workflow.match(/^  draft_pr:\n([\s\S]*?)^  finish:/m)?.[1] ?? "";
const finish = workflow.match(/^  finish:\n([\s\S]*)$/m)?.[1] ?? "";

test("manual dispatch accepts only the approved request identifier", () => {
  const dispatch = workflow.split("  workflow_dispatch:")[1]?.split("\npermissions:")[0] ?? "";
  assert.match(dispatch, /request_id:/);
  assert.doesNotMatch(dispatch, /instruction:/);
  assert.match(prepare, /id-token: write/);
  assert.match(prepare, /environment: CODE/);
  assert.ok(
    prepare.indexOf("name: Claim approved request") < prepare.indexOf("uses: actions/checkout@"),
  );
  assert.ok(
    prepare.indexOf("uses: actions/checkout@") < prepare.indexOf("uses: openai/codex-action@"),
  );
});

test("publisher is separately authorized and all Actions are pinned to full SHAs", () => {
  assert.match(publisher, /needs: prepare/);
  assert.match(publisher, /environment: CODE-PUBLISH/);
  assert.match(publisher, /contents: write/);
  assert.match(publisher, /pull-requests: write/);
  assert.match(publisher, /id-token: write/);
  assert.doesNotMatch(publisher, /openai-api-key|codex-action/);
  assert.ok(
    publisher.indexOf("name: Claim independent publishing authorization") <
      publisher.indexOf("uses: actions/checkout@"),
  );
  const actions = [...workflow.matchAll(/^\s+uses:\s+([^\s]+)/gm)].map((match) => match[1]);
  assert.ok(actions.length > 0);
  assert.ok(actions.every((action) => /^[^@]+@[a-f0-9]{40}$/.test(action)));
});

test("finalization records outcome without repository write permissions or an environment secret", () => {
  assert.match(finish, /if: always\(\)/);
  assert.match(finish, /needs: \[prepare, draft_pr\]/);
  assert.match(finish, /id-token: write/);
  assert.doesNotMatch(finish, /environment:|contents: write|pull-requests: write|secrets\./);
  assert.match(finish, /\/api\/public\/code\/finish/);
});
