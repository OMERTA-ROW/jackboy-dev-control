import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { safeCodePath, validateCodePatch } from '../scripts/code-patch.mjs';
test('publisher gate refuses credentials, workflows, auth, migrations, CODE and path escapes', () => {
  for (const p of ['.env', '.github/workflows/evil.yml', 'src/auth.ts', 'src/lib/passkey.server.ts', 'supabase/config.toml', 'drizzle/migrations/a.sql', 'scripts/code-patch.mjs', 'src/lib/code.server.ts', 'package.json', '../a', 'a\\b', 'file with spaces']) assert.equal(safeCodePath(p), false, p);
  assert.equal(safeCodePath('src/components/Footer.tsx'), true);
});
test('real git patch is checked against a pristine checkout; symlink and protected patch refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-patch-'));
  const git = async (...args) => (await exec('git', args, { cwd: dir, encoding: 'utf8' })).stdout;
  try {
    await git('init', '-q'); writeFileSync(join(dir, 'hello.txt'), 'before\n'); await git('add', '.'); await git('-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'base');
    writeFileSync(join(dir, 'hello.txt'), 'after\n'); const patch = await git('diff'); await git('checkout', '--', 'hello.txt');
    const file = join(dir, 'change.patch'); writeFileSync(file, patch); assert.equal(await validateCodePatch(file, dir), 1);
    writeFileSync(file, patch.replaceAll('hello.txt', '.env')); await assert.rejects(() => validateCodePatch(file, dir), /protected/);
    writeFileSync(file, patch + '\nnew file mode 120000\n'); await assert.rejects(() => validateCodePatch(file, dir), /symlinks/);
    writeFileSync(file, ''); await assert.rejects(() => validateCodePatch(file, dir), /no diff/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
