// Fixed trusted diagnostic only: no caller code, repository, path or argv is accepted.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const SCRIPT = `const a=require('node:assert/strict');const c=require('node:crypto');a.equal(c.createHash('sha256').update('abc').digest('hex'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');a.ok(Object.keys(process.env).every(k=>k==='__CF_USER_TEXT_ENCODING'));a.ok(['fs.read','fs.write','child','worker','net'].every(k=>!process.permission.has(k)));`;
// Explicit host opt-in; Cloudflare web routes remain non-executing.
export function protocolRunnerAvailable(): boolean {
  return (
    process.env["OMNI_LINK_NODE_RUNNER_ENABLED"] === "true" &&
    process.release?.name === "node" &&
    Number(process.versions.node.split(".")[0]) >= 26 &&
    Boolean(process.allowedNodeEnvironmentFlags?.has("--permission"))
  );
}
export async function runProtocolSelfTest(signal: AbortSignal): Promise<boolean> {
  if (!protocolRunnerAvailable()) return false;
  const dir = await mkdtemp(join(tmpdir(), "jackboy-protocol-"));
  try {
    return await new Promise<boolean>((resolve) => {
      execFile(
        process.execPath,
        ["--permission", "--eval", SCRIPT],
        {
          cwd: dir,
          env: {},
          timeout: 3000,
          maxBuffer: 1024,
          signal,
        },
        (error) => resolve(!error),
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
