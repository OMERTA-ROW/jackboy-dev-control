import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodeCommand, codeVoiceDecision, codeApprovalError, codeLink } from '../src/lib/code.ts';
const id = '12345678-1234-4234-8234-123456789abc';
test('CODE extracts one named project and task without invoking a model', () => {
  assert.deepEqual(parseCodeCommand('CODE Jackboy: fix the footer'), { project: 'Jackboy', instruction: 'fix the footer' });
  assert.equal(parseCodeCommand('CODE fix everything'), null);
  assert.equal(parseCodeCommand('CODE Jackboy: '), null);
});
test('voice approval must name exactly the pending request', () => {
  assert.equal(codeVoiceDecision(`Allow CODE ${id}`, id), 'allow');
  assert.equal(codeVoiceDecision(`Deny CODE ${id}.`, id), 'deny');
  for (const t of ['yes', 'confirm', 'approve', `Allow CODE ${id} and deploy`, `Allow CODE ${crypto.randomUUID()}`]) assert.equal(codeVoiceDecision(t, id), null);
});
test('approval rejects changed identity, session, expiry, malformed expiry and replay', () => {
  const row = { status: 'pending', requested_by: 'owner', expires_at: new Date(2000).toISOString(), resources: { sessionHash: 'session' } };
  assert.equal(codeApprovalError(row, 'owner', 'session', 1000), null);
  for (const [r, user, session] of [[row, 'other', 'session'], [row, 'owner', 'other'], [{ ...row, status: 'allowed' }, 'owner', 'session'], [{ ...row, expires_at: 'invalid' }, 'owner', 'session']]) assert.ok(codeApprovalError(r, user, session, 1000));
  assert.ok(codeApprovalError(row, 'owner', 'session', 2000));
});
test('links must be real GitHub resource types within the selected repository', () => {
  for (const suffix of ['actions/runs/1', 'actions/runs/1/artifacts/2', 'pull/3']) assert.ok(codeLink(`https://github.com/owner/repo/${suffix}`, 'owner/repo'));
  for (const u of ['javascript:alert(1)', 'https://github.com.evil.test/owner/repo/pull/1', 'https://github.com/other/repo/pull/1', 'https://evil@github.com/owner/repo/pull/1', 'https://github.com/owner/repo/settings', 'https://github.com/owner/repo/pull/1#other']) assert.equal(codeLink(u, 'owner/repo'), null);
});
