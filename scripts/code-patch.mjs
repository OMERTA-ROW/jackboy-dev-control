// Trusted runner gate. Run from the pristine publishing checkout BEFORE applying the model patch.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

export function safeCodePath(path) {
  if (!path || path.length > 300 || path.startsWith('/') || path.includes('\\') || /[\x00-\x20\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) return false;
  return !/(^|\/)(\.git[^/]*|\.env[^/]*|\.npmrc|\.bunfig[^/]*|AGENTS\.md|node_modules|secrets?)(\/|$)|(^|\/)(auth[^/]*|passkey[^/]*|step-up[^/]*|.*credential.*|.*permission.*)(\/|\.|$)|\.(pem|key)$|^((drizzle|supabase)\/|src\/integrations\/|(scripts|tests)\/code-|src\/components\/CodeTasks\.tsx$|src\/lib\/(code|voice-guard|github)[^/]*|package(-lock)?\.json$|bun\.lock$|bunfig\.toml$)/i.test(path);
}
export async function validateCodePatch(file, cwd = process.cwd()) {
  if (statSync(file).size > 500_000) throw new Error('CODE patch exceeds 500 KB.');
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) throw new Error('CODE produced no diff; there is no change to publish.');
  if (/^(new file mode|old mode|new mode) 1[26]0000$/m.test(text) || /^GIT binary patch$/m.test(text)) throw new Error('CODE cannot publish symlinks, submodules or binary patches.');
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', 'apply', '--numstat', '-z', file], { cwd, encoding: 'utf8', maxBuffer: 1_000_000 });
  const names = stdout.split('\0').filter(Boolean);
  if (!names.length || names.length > 20) throw new Error('CODE permits 1–20 changed files per job.');
  for (const line of names) {
    const parts = line.split('\t');
    if (parts.length !== 3 || parts[0] === '-' || parts[1] === '-' || !safeCodePath(parts[2])) throw new Error(`CODE protected or invalid patch path: ${parts.at(-1)}`);
  }
  await exec('git', ['apply', '--check', '--index', file], { cwd });
  return names.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await validateCodePatch(process.argv[2]);
