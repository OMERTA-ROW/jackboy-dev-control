import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/code.yml", import.meta.url), "utf8");
const prepare = workflow.match(/^  prepare:\n([\s\S]*?)^  validate:/m)?.[1] ?? "";
const publisher = workflow.match(/^  draft_pr:\n([\s\S]*?)^  finish:/m)?.[1] ?? "";
const finish = workflow.match(/^  finish:\n([\s\S]*)$/m)?.[1] ?? "";

test("CODE uses only request-bound Actions identity at the gateway, with no secret fallback", () => {
  assert.doesNotMatch(prepare, /secrets\.|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  assert.match(prepare, /openai-api-key: \$\{\{ steps\.gateway\.outputs\.token \}\}/);
  assert.match(prepare, /responses-api-endpoint: \$\{\{ steps\.gateway\.outputs\.endpoint \}\}/);
  assert.match(prepare, /\/api\/public\/code\/provider\/v1\/responses/);
  assert.match(prepare, /endpoint\.searchParams\.set\('request_id', process\.env\.CODE_REQUEST\)/);
  assert.match(prepare, /::add-mask::/);
  assert.ok(prepare.indexOf("name: Bind gateway") < prepare.indexOf("uses: openai/codex-action@"));
  assert.doesNotMatch(prepare, /api\.openai\.com|api\.anthropic\.com|persist-credentials: true/);
});

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
  assert.match(publisher, /needs: \[prepare, validate\]/);
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
  assert.match(finish, /needs: \[prepare, validate, draft_pr\]/);
  assert.match(finish, /id-token: write/);
  assert.doesNotMatch(finish, /environment:|contents: write|pull-requests: write|secrets\./);
  assert.match(finish, /\/api\/public\/code\/finish/);
});
