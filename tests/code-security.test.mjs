import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTool } from '../src/lib/voice-guard.ts';
import { canDecide } from '../src/lib/action-approval.ts';
const voice = text => ({ role: 'user', metadata: { voice: true }, parts: [{ type: 'text', text }] });
test('unbound voice confirmation never unlocks a bounded or sensitive legacy tool', () => {
  for (const tool of ['writeFile', 'openDraftPR', 'foundryDecide', 'setAutopilot', 'linkRepo']) {
    assert.equal(decideTool(tool, [voice('fix my project'), { role: 'assistant', parts: [] }, voice('confirm')]).allow, false);
  }
});
test('approval cards fail closed on invalid expiry and require passkeys for critical actions', () => {
  const row = { status: 'pending', expires_at: 'invalid', tier: 'controlled', requested_by: 'owner' };
  assert.ok(canDecide(row, 'owner', 'allow_once', false));
  assert.match(canDecide({ ...row, expires_at: new Date(Date.now() + 60_000).toISOString(), tier: 'critical' }, 'owner', 'allow_once', false), /passkey/);
});
