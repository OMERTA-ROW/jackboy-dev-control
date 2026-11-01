// Reference updater client (run on an authorized target). It never executes downloaded content:
// it verifies the Ed25519 manifest signature and SHA-256 artifact hash, stages the file, runs a health check, reports each phase.
// Usage: JACKBOY_URL=... JACKBOY_TARGET_TOKEN=... CURRENT_VERSION=1.0.0 INSTALL_DIR=./installed bun scripts/updater-client.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { verifyPayload } from "../src/lib/update-server";

const env = () => ({ base: process.env.JACKBOY_URL!, token: process.env.JACKBOY_TARGET_TOKEN!, dir: process.env.INSTALL_DIR ?? "./installed",
  forceUnhealthy: process.env.FORCE_UNHEALTHY === "1" }); // FORCE_UNHEALTHY: test hook simulating a failed post-install health check
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const post = (path: string, body: unknown) => fetch(env().base + path, { method: "POST", headers: { authorization: `Bearer ${env().token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

export async function runOnce(current: string) {
  const { base, dir, forceUnhealthy: FORCE_UNHEALTHY } = env();
  const res = await post("/api/public/updates/target-check", { version: current });
  if (!res.update) return { action: "none", res };
  const m = res.manifest;
  const report = (phase: string, detail = "") => post("/api/public/updates/target-report", { release_id: m.release_id, version: m.version, phase, detail, key: `${m.release_id}:${phase}` });
  const { public_key } = await fetch(base + "/api/public/updates/public-key").then((r) => r.json());
  if (!(await verifyPayload(public_key, m, res.signature))) return { action: "rejected", reason: "bad signature" };
  let bytes: ArrayBuffer | null = null;
  if (m.artifact) {
    bytes = await fetch(res.download_url).then((r) => r.arrayBuffer());
    await report("downloaded");
    if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== m.artifact.sha256) { await report("failed", "hash mismatch"); return { action: "rejected", reason: "hash mismatch" }; }
  }
  await report("verified", "signature + sha256 ok");
  await mkdir(dir, { recursive: true });
  if (bytes) await writeFile(`${dir}/${m.artifact.file}`, new Uint8Array(bytes));
  await writeFile(`${dir}/manifest.json`, JSON.stringify(m));
  await report(res.rollback ? "rolled_back" : "installed", res.rollback ? "reverted to previous signed release" : "");
  const disk = bytes ? hex(await crypto.subtle.digest("SHA-256", await readFile(`${dir}/${m.artifact.file}`))) : m.artifact?.sha256;
  const healthy = !FORCE_UNHEALTHY && (!m.artifact || disk === m.artifact.sha256);
  if (res.rollback) return { action: "rolled_back", version: m.version };
  const h = await report(healthy ? "healthy" : "failed", healthy ? "post-install hash readback ok" : "post-install health check failed");
  return { action: healthy ? "installed" : "failed", version: m.version, server: h };
}

if (import.meta.main) console.log(JSON.stringify(await runOnce(process.env.CURRENT_VERSION ?? "0.0.0")));
