// Isolated integration test: real CODE server logic, fake database and GitHub transport. No paid calls.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const records = { action_requests: [], owner_projects: [], audit_logs: [] };
let run, dispatches, cancellations, retries, auditFails, uncertain;
class Query {
  constructor(table) { this.table = table; this.filters = []; this.operation = 'select'; }
  select() { return this; }
  insert(value) { this.operation = 'insert'; this.value = value; return this; }
  update(value) { this.operation = 'update'; this.value = value; return this; }
  eq(key, value) { this.filters.push(r => r[key] === value); return this; }
  gt(key, value) { this.filters.push(r => r[key] > value); return this; }
  limit(n) { this.limitValue = n; return this; }
  execute(single = false) {
    if (this.table === 'audit_logs' && auditFails) return { data: null, error: { message: 'audit unavailable' } };
    let rows = records[this.table].filter(r => this.filters.every(f => f(r)));
    if (this.operation === 'insert') {
      const row = { status: 'pending', outcome: null, ...this.value };
      records[this.table].push(row); rows = [row];
    }
    if (this.operation === 'update') rows.forEach(r => Object.assign(r, this.value));
    if (this.limitValue) rows = rows.slice(0, this.limitValue);
    return { data: single ? rows[0] ?? null : rows, error: null };
  }
  single() { return Promise.resolve(this.execute(true)); }
  maybeSingle() { return this.single(); }
  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
}
globalThis.__codeDb = { from: table => new Query(table) };
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/integrations/supabase/client.server') return next('data:text/javascript,export const supabaseAdmin = globalThis.__codeDb', context);
  if (specifier.startsWith('./') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
  if (specifier.endsWith('.server') || specifier === './voice-guard') return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { requestCode, decideCode, getCode, controlCode, codeProjectId } = await import('../src/lib/code.server.ts');
const projectId = '00000000-0000-4000-8000-000000000001';
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  const json = data => Response.json(data);
  if (path === '/repos/owner/repo') return json({ default_branch: 'main' });
  if (path.includes('/contents/')) return json({ sha: 'a'.repeat(40) });
  if (path.endsWith('/actions/workflows/code.yml')) return json({ state: 'active' });
  if (path.endsWith('/dispatches')) {
    dispatches++;
    if (uncertain) throw new Error('connection reset after request');
    run = { id: 42, display_title: `CODE ${JSON.parse(init.body).inputs.request_id}`, status: 'in_progress', conclusion: null, html_url: 'https://github.com/owner/repo/actions/runs/42' };
    return new Response(null, { status: 204 });
  }
  if (path.endsWith('/cancel')) { cancellations++; run.status = 'completed'; run.conclusion = 'cancelled'; return new Response(null, { status: 202 }); }
  if (path.endsWith('/rerun-failed-jobs')) { retries++; run.status = 'queued'; run.conclusion = null; return new Response(null, { status: 201 }); }
  if (path.endsWith('/jobs')) return json({ jobs: [{ name: 'prepare', status: run.status, conclusion: run.conclusion }] });
  if (path.endsWith('/artifacts')) return json({ artifacts: [{ id: 7, name: 'code-evidence', expired: false }] });
  if (path.endsWith('/pulls')) return json(run?.conclusion === 'success' ? [{ draft: true, html_url: 'https://github.com/owner/repo/pull/8' }] : []);
  if (path.endsWith('/runs/42')) return json(run);
  if (path.endsWith('/runs')) return json({ workflow_runs: run ? [run] : [] });
  throw new Error(`Unexpected GitHub request ${path}`);
};
beforeEach(() => {
  Object.values(records).forEach(rows => rows.splice(0));
  records.owner_projects.push({ id: projectId, name: 'Jackboy', github_repo: 'owner/repo', dev_enabled: true });
  process.env.CODE_TARGETS = JSON.stringify({ 'owner/repo': { ref: 'main', workflowSha: 'a'.repeat(40) } });
  process.env.CODE_GITHUB_TOKEN = 'isolated-test-placeholder';
  run = undefined; dispatches = cancellations = retries = 0; auditFails = uncertain = false;
});
test('voice/text intent → pending approval → real server dispatch path → evidence and draft PR (mock transport)', async () => {
  assert.equal(await codeProjectId('Jackboy'), projectId);
  const card = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  assert.equal(card.status, 'pending'); assert.equal(dispatches, 0); assert.ok(card.nonce);
  const after = await decideCode(card.id, card.nonce, 'allow', 'owner', 'session');
  assert.equal(dispatches, 1); assert.equal(after.run.id, 42); assert.equal(after.nonce, undefined);
  run.status = 'completed'; run.conclusion = 'success';
  const finished = await getCode(card.id, 'owner');
  assert.equal(finished.run.pr, 'https://github.com/owner/repo/pull/8');
  assert.equal(finished.run.downloads[0].url, 'https://github.com/owner/repo/actions/runs/42/artifacts/7');
  assert.ok(records.audit_logs.some(x => x.action === 'code.allow'));
});
test('replay, wrong nonce, wrong owner, wrong session and expiry cannot dispatch', async () => {
  const card = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  await assert.rejects(() => decideCode(card.id, card.nonce, 'allow', 'other', 'session'));
  await assert.rejects(() => decideCode(card.id, card.nonce, 'allow', 'owner', 'other'));
  await assert.rejects(() => decideCode(card.id, '0'.repeat(48), 'allow', 'owner', 'session'));
  assert.equal(dispatches, 0);
  await decideCode(card.id, card.nonce, 'allow', 'owner', 'session');
  await assert.rejects(() => decideCode(card.id, card.nonce, 'allow', 'owner', 'session'));
  assert.equal(dispatches, 1);
  const expired = await requestCode(projectId, 'Other task', 'owner', 'session');
  records.action_requests.find(r => r.id === expired.id).expires_at = new Date(0).toISOString();
  await assert.rejects(() => decideCode(expired.id, expired.nonce, 'allow', 'owner', 'session'));
  assert.equal(dispatches, 1);
});
test('concurrent decisions have only one winner', async () => {
  const c = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  const results = await Promise.allSettled([decideCode(c.id, c.nonce, 'allow', 'owner', 'session'), decideCode(c.id, c.nonce, 'allow', 'owner', 'session')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(dispatches, 1);
});
test('deny executes nothing, cancellation reaches provider, retry needs a fresh approval', async () => {
  const denied = await requestCode(projectId, 'No', 'owner', 'session');
  await decideCode(denied.id, denied.nonce, 'deny', 'owner', 'session'); assert.equal(dispatches, 0);
  const c = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  await decideCode(c.id, c.nonce, 'allow', 'owner', 'session');
  await controlCode(c.id, 'cancel', 'owner', 'session'); assert.equal(cancellations, 1);
  const retry = await controlCode(c.id, 'retry', 'owner', 'session');
  assert.equal(retry.status, 'pending'); assert.equal(retries, 0);
  await decideCode(retry.id, retry.nonce, 'allow', 'owner', 'session'); assert.equal(retries, 1); assert.equal(dispatches, 1);
});
test('unknown dispatch outcome is not automatically redispatched', async () => {
  uncertain = true;
  const c = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  await decideCode(c.id, c.nonce, 'allow', 'owner', 'session');
  await getCode(c.id, 'owner'); await getCode(c.id, 'owner');
  assert.equal(dispatches, 1);
  await assert.rejects(() => decideCode(c.id, c.nonce, 'allow', 'owner', 'session'));
});
test('unapproved workflow, disabled project, missing credential and failed audit fail closed', async () => {
  process.env.CODE_TARGETS = '{}';
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  process.env.CODE_TARGETS = JSON.stringify({ 'owner/repo': { ref: 'main', workflowSha: 'b'.repeat(40) } });
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  process.env.CODE_TARGETS = JSON.stringify({ 'owner/repo': { ref: 'main', workflowSha: 'a'.repeat(40) } });
  records.owner_projects[0].dev_enabled = false;
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  records.owner_projects[0].dev_enabled = true;
  delete process.env.CODE_GITHUB_TOKEN;
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  process.env.CODE_GITHUB_TOKEN = 'isolated-test-placeholder'; auditFails = true;
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  assert.equal(dispatches, 0);
});
