// Isolated integration test: real CODE server logic, fake database and GitHub transport. No paid calls.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const records = { action_requests: [], owner_projects: [], audit_logs: [], omni_connection: [], omni_jobs: [], code_runtime_controls: [], code_usage_events: [], code_spend_reservations: [] };
let run, dispatches, omniDispatches, cancellations, retries, auditFails, uncertain, afterAllowAudit, failingTable;
class Query {
  constructor(table) { this.table = table; this.filters = []; this.operation = 'select'; }
  select() { return this; }
  insert(value) { this.operation = 'insert'; this.value = value; return this; }
  upsert(value) { this.operation = 'upsert'; this.value = value; return this; }
  update(value) { this.operation = 'update'; this.value = value; return this; }
  eq(key, value) { this.filters.push(r => r[key] === value); return this; }
  neq(key, value) { this.filters.push(r => r[key] !== value); return this; }
  gt(key, value) { this.filters.push(r => r[key] > value); return this; }
  gte(key, value) { this.filters.push(r => r[key] >= value); return this; }
  lte(key, value) { this.filters.push(r => r[key] <= value); return this; }
  order() { return this; }
  limit(n) { this.limitValue = n; return this; }
  execute(single = false) {
    if (this.table === failingTable) return { data: null, error: { message: 'source unavailable' } };
    if (this.table === 'audit_logs' && auditFails) return { data: null, error: { message: 'audit unavailable' } };
    let rows = records[this.table].filter(r => this.filters.every(f => f(r)));
    if (this.operation === 'insert' || this.operation === 'upsert') {
      const existing = this.operation === 'upsert' && this.value.code_request_id
        ? records[this.table].find(r => r.code_request_id === this.value.code_request_id)
        : null;
      if (existing) rows = [existing];
      else {
        const row = {
          status: this.table === 'omni_jobs' ? 'queued' : 'pending',
          outcome: null,
          id: this.table === 'omni_jobs' ? crypto.randomUUID() : undefined,
          attempts: 0,
          created_at: new Date().toISOString(),
          next_attempt_at: new Date().toISOString(),
          ...this.value,
        };
        records[this.table].push(row); rows = [row];
        if (this.table === 'audit_logs' && row.action === 'code.allow') afterAllowAudit?.();
      }
    }
    if (this.operation === 'update') rows.forEach(r => Object.assign(r, this.value));
    if (this.limitValue) rows = rows.slice(0, this.limitValue);
    return { data: single ? rows[0] ?? null : rows, error: null };
  }
  single() { return Promise.resolve(this.execute(true)); }
  maybeSingle() { return this.single(); }
  then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
}
let totalGuard; // stand-in for code_total_spend_guard_status(); null = guard not installed
let spendMeter; // stand-in for code_spend_meter_status(); null = meter not installed
globalThis.__codeDb = {
  from: table => new Query(table),
  rpc: async name => name === 'code_total_spend_guard_status' && totalGuard
    ? { data: totalGuard, error: null }
    : name === 'code_spend_meter_status' && spendMeter
      ? { data: spendMeter, error: null }
      : { data: null, error: { message: 'function does not exist' } },
};
const healthyMeter = () => ({ ok: true, reasons: [], measured_at: new Date().toISOString(), measured_today_usd: 0, gateway_today_usd: 0, provider_today_usd: 0, gateway_hour_usd: 0, unreported_days: [], bypass_days: [] });
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
  if (path === '/repos/OMERTA-ROW/jackboy-dev-control') return json({ default_branch: 'main' });
  if (path.endsWith('/commits/main')) return json({ sha: 'b'.repeat(40) });
  if (path.includes('/contents/')) return json({ sha: 'a'.repeat(40) });
  if (path.endsWith('/actions/workflows/code.yml')) return json({ state: 'active' });
  if (path === '/jackboy/jobs') {
    omniDispatches++;
    return json({ ref: 'omni-job-1' }, { status: 202 });
  }
  if (path.endsWith('/dispatches')) {
    dispatches++;
    if (uncertain) throw new Error('connection reset after request');
    run = { id: 42, display_title: `CODE ${JSON.parse(init.body).inputs.request_id}`, status: 'in_progress', conclusion: null, html_url: 'https://github.com/OMERTA-ROW/jackboy-dev-control/actions/runs/42' };
    return new Response(null, { status: 204 });
  }
  if (path.endsWith('/cancel')) { cancellations++; run.status = 'completed'; run.conclusion = 'cancelled'; return new Response(null, { status: 202 }); }
  if (path.endsWith('/rerun-failed-jobs')) { retries++; run.status = 'queued'; run.conclusion = null; return new Response(null, { status: 201 }); }
  if (path.endsWith('/jobs')) return json({ jobs: [{ name: 'prepare', status: run.status, conclusion: run.conclusion }] });
  if (path.endsWith('/artifacts')) return json({ artifacts: [{ id: 7, name: 'code-evidence', expired: false }] });
  if (path.endsWith('/pulls')) return json(run?.conclusion === 'success' ? [{ draft: true, html_url: 'https://github.com/OMERTA-ROW/jackboy-dev-control/pull/8' }] : []);
  if (path.endsWith('/runs/42')) return json(run);
  if (path.endsWith('/runs')) return json({ workflow_runs: run ? [run] : [] });
  throw new Error(`Unexpected GitHub request ${path}`);
};
beforeEach(() => {
  Object.values(records).forEach(rows => rows.splice(0));
  records.owner_projects.push({ id: projectId, name: 'Jackboy', github_repo: 'OMERTA-ROW/jackboy-dev-control', dev_enabled: true });
  records.omni_connection.push({ id: true, verified: false });
  records.code_runtime_controls.push({
    singleton: true,
    enabled: true,
    kill_switch: false,
    allowed_targets: { 'OMERTA-ROW/jackboy-dev-control': { ref: 'main', workflowSha: 'a'.repeat(40) } },
    active_request_id: null,
    consecutive_failures: 0,
    daily_spend_limit_usd: 5,
    provider_hard_cap_verified: true,
    provider_usage_at: new Date().toISOString(),
    per_task_reserve_usd: 1,
    usage_spike: false,
    paused_reason: null,
  });
  process.env.CODE_GITHUB_TOKEN = 'isolated-test-placeholder';
  process.env.CODE_TARGETS = JSON.stringify({ 'OMERTA-ROW/jackboy-dev-control': { ref: 'main', workflowSha: 'a'.repeat(40) } });
  process.env.OMNI_API_URL = 'https://omni.example';
  process.env.OMNI_API_KEY = 'isolated-test-api-key';
  process.env.OMNI_CALLBACK_SECRET = 'isolated-test-callback-secret';
  run = undefined; dispatches = omniDispatches = cancellations = retries = 0; auditFails = uncertain = false; afterAllowAudit = undefined; failingTable = undefined; totalGuard = { enforced: true, limit_usd: 10, committed_usd: 0 }; spendMeter = healthyMeter();
});
test('voice/text intent → pending approval → real server dispatch path → evidence and draft PR (mock transport)', async () => {
  assert.equal(await codeProjectId('Jackboy'), projectId);
  const card = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  assert.equal(card.status, 'pending'); assert.equal(dispatches, 0); assert.ok(card.nonce);
  const after = await decideCode(card.id, card.nonce, 'allow', 'owner', 'session');
  assert.equal(dispatches, 1); assert.equal(after.run.id, 42); assert.equal(after.nonce, undefined);
  assert.equal(records.action_requests.find(r => r.id === card.id).resources.runId, 42);
  run.status = 'completed'; run.conclusion = 'success';
  const finished = await getCode(card.id, 'owner');
  assert.equal(finished.run.pr, 'https://github.com/OMERTA-ROW/jackboy-dev-control/pull/8');
  assert.equal(finished.run.downloads[0].url, 'https://github.com/OMERTA-ROW/jackboy-dev-control/actions/runs/42/artifacts/7');
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
test('CODE uses GitHub when OMNI verification is absent', async () => {
  const c = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  await decideCode(c.id, c.nonce, 'allow', 'owner', 'session');
  assert.equal(dispatches, 1);
  assert.equal(omniDispatches, 0);
  assert.equal(records.omni_jobs.length, 0);
});
test('CODE stays on the GitHub runner even when OMNI is verified', async () => {
  records.omni_connection[0].verified = true;
  const c = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  await decideCode(c.id, c.nonce, 'allow', 'owner', 'session');
  assert.equal(records.action_requests.find(r => r.id === c.id).outcome, 'Accepted by GitHub; waiting for runner evidence');
  assert.equal(dispatches, 1);
  assert.equal(omniDispatches, 0);
  assert.equal(records.omni_jobs.length, 0);
});
test('deny executes nothing, cancellation reaches provider, retry needs a fresh approval', async () => {
  const denied = await requestCode(projectId, 'No', 'owner', 'session');
  await decideCode(denied.id, denied.nonce, 'deny', 'owner', 'session'); assert.equal(dispatches, 0);
  const c = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  await decideCode(c.id, c.nonce, 'allow', 'owner', 'session');
  await controlCode(c.id, 'cancel', 'owner', 'session'); assert.equal(cancellations, 1);
  const retry = await controlCode(c.id, 'retry', 'owner', 'session');
  assert.equal(retry.status, 'pending'); assert.equal(retries, 0);
  await decideCode(retry.id, retry.nonce, 'allow', 'owner', 'session'); assert.equal(retries, 0); assert.equal(dispatches, 2);
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
  records.code_runtime_controls[0].allowed_targets = {};
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  records.code_runtime_controls[0].allowed_targets = { 'OMERTA-ROW/jackboy-dev-control': { ref: 'main', workflowSha: 'b'.repeat(40) } };
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  records.code_runtime_controls[0].allowed_targets = { 'OMERTA-ROW/jackboy-dev-control': { ref: 'main', workflowSha: 'a'.repeat(40) } };
  records.owner_projects[0].dev_enabled = false;
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  records.owner_projects[0].dev_enabled = true;
  delete process.env.CODE_GITHUB_TOKEN;
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  process.env.CODE_GITHUB_TOKEN = 'isolated-test-placeholder'; auditFails = true;
  await assert.rejects(() => requestCode(projectId, 'Fix footer', 'owner', 'session'));
  assert.equal(dispatches, 0);
});


test('invalid or unverified admission meter never dispatches', async () => {
  const controls = records.code_runtime_controls[0];
  for (const patch of [
    { provider_hard_cap_verified: false },
    { provider_usage_at: null },
    { provider_usage_at: new Date(Date.now() - 360_000).toISOString() },
    { provider_usage_at: new Date(Date.now() + 60_000).toISOString() },
  ]) {
    Object.assign(controls, { provider_hard_cap_verified: true, provider_usage_at: new Date().toISOString() }, patch);
    await assert.rejects(requestCode(projectId, 'Fix footer', 'owner', 'session'));
    assert.equal(dispatches, 0);
  }
  Object.assign(controls, { provider_hard_cap_verified: true, provider_usage_at: new Date().toISOString() });
  records.code_usage_events.push({ cost_usd: -1, occurred_at: new Date().toISOString() });
  await assert.rejects(requestCode(projectId, 'Fix footer', 'owner', 'session'));
  assert.equal(dispatches, 0);
});

test('a delayed $5 report immediately returns stopped state and records a pause alert', async () => {
  const { getCodeSafetyState } = await import('../src/lib/code-safety.server.ts');
  records.code_runtime_controls[0].provider_hard_cap_verified = false;
  records.code_runtime_controls[0].provider_usage_at = null;
  records.code_usage_events.push({ cost_usd: 5, occurred_at: new Date().toISOString() });
  const safety = await getCodeSafetyState();
  assert.equal(safety.enabled, false);
  assert.equal(safety.killSwitch, true);
  assert.equal(records.code_runtime_controls[0].kill_switch, true);
  assert.ok(records.audit_logs.some(event => event.action === 'code.usage_spike_pause' || event.action === 'code.daily_spend_cap_pause'));
  assert.equal(dispatches, 0);
});

test('a $2.50 hourly spike pauses and audits without needing a fresh admission meter', async () => {
  const { getCodeSafetyState } = await import('../src/lib/code-safety.server.ts');
  records.code_runtime_controls[0].provider_usage_at = null;
  records.code_usage_events.push({ cost_usd: 2.5, occurred_at: new Date().toISOString() });
  const safety = await getCodeSafetyState();
  assert.equal(safety.usageSpike, true);
  assert.equal(safety.killSwitch, true);
  assert.ok(records.audit_logs.some(event => event.action === 'code.usage_spike_pause'));
  assert.equal(dispatches, 0);
});


for (const [name, invalidate] of [
  ['stale usage', () => { records.code_runtime_controls[0].provider_usage_at = new Date(Date.now() - 360_000).toISOString(); }],
  ['missing usage', () => { records.code_runtime_controls[0].provider_usage_at = null; }],
  ['future usage', () => { records.code_runtime_controls[0].provider_usage_at = new Date(Date.now() + 60_000).toISOString(); }],
  ['unverified cap', () => { records.code_runtime_controls[0].provider_hard_cap_verified = false; }],
  ['exhausted budget', () => { records.code_usage_events.push({ cost_usd: 5, occurred_at: new Date().toISOString() }); }],
  ['negative spend', () => { records.code_usage_events.push({ cost_usd: -1, occurred_at: new Date().toISOString() }); }],
  ['missing controls', () => { records.code_runtime_controls.splice(0); }],
  ['unreconciled reservation holds exhaust the budget', () => { records.code_spend_reservations.push({ status: 'finished', reserved_usd: 4.5 }); }],
  ['failed reservation source', () => { failingTable = 'code_spend_reservations'; }],
  ['missing per-task reserve', () => { records.code_runtime_controls[0].per_task_reserve_usd = null; }],
  ['failed meter source', () => { failingTable = 'code_usage_events'; }],
  ['emergency stop', () => { records.code_runtime_controls[0].kill_switch = true; }],
  ['cumulative $10 guard not installed', () => { totalGuard = null; }],
  ['cumulative $10 guard not enforced', () => { totalGuard = { enforced: false, limit_usd: 10, committed_usd: 0 }; }],
  ['cumulative $10 total would be exceeded', () => { totalGuard = { enforced: true, limit_usd: 10, committed_usd: 9.5 }; }],
  ['live spending meter not installed', () => { spendMeter = null; }],
  ['live spending meter unhealthy', () => { spendMeter = { ...healthyMeter(), ok: false, reasons: ['unreported_days'] }; }],
]) {
  test(`evidence becoming invalid after approval audit blocks dispatch: ${name}`, async () => {
    const c = await requestCode(projectId, 'Fix footer', 'owner', 'session');
    afterAllowAudit = invalidate;
    await assert.rejects(decideCode(c.id, c.nonce, 'allow', 'owner', 'session'));
    assert.equal(dispatches, 0);
    assert.equal(omniDispatches, 0);
    assert.equal(records.action_requests[0].status, 'allowed');
    assert.match(records.action_requests[0].outcome, /blocked/i);
    await assert.rejects(decideCode(c.id, c.nonce, 'allow', 'owner', 'session'));
    assert.equal(dispatches, 0);
  });
}
test('evidence invalidated while approval card waits is rejected before consuming consent', async () => {
  const c = await requestCode(projectId, 'Fix footer', 'owner', 'session');
  records.code_runtime_controls[0].provider_usage_at = new Date(0).toISOString();
  await assert.rejects(decideCode(c.id, c.nonce, 'allow', 'owner', 'session'));
  assert.equal(records.action_requests[0].status, 'pending');
  assert.equal(dispatches, 0);
});
