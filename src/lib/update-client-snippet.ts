// Shared update-client template: shown on Update Docs and committed by Auto-connect with the key filled in.
export const clientSnippet = (origin: string, clientKey = "jbp_YOUR_CLIENT_KEY", publicKey = "PASTE_PUBLIC_KEY") => `// jackboy-updates.ts — drop into any web project
const JACKBOY = "${origin}/api/public/updates";
const PROJECT = "${clientKey}";   // this project's Jackboy client key (not a secret)
const CHANNEL = "live";                  // "test" | "beta" | "live"
const VERSION = "1.0.0";                 // this build's version
const PUBLIC_KEY = "${publicKey}";   // Jackboy signing public key

function deviceId() {
  let id = localStorage.getItem("jb_device");
  if (!id) { id = crypto.randomUUID().replace(/-/g, ""); localStorage.setItem("jb_device", id); }
  return id;
}
function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function verify(payload: unknown, signature: string) {
  const key = await crypto.subtle.importKey("raw", b64(PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, b64(signature), new TextEncoder().encode(canonical(payload)));
}

export async function checkForUpdate() {
  const q = new URLSearchParams({ project: PROJECT, version: VERSION, channel: CHANNEL, device: deviceId() });
  const res = await (await fetch(\`\${JACKBOY}/check?\${q}\`)).json();
  if (!res.update) return null;
  if (!(await verify(res.manifest, res.signature))) throw new Error("Update signature invalid — ignoring");
  // res.manifest: { version, notes, config, artifact: { sha256, size } | null }, res.downgrade = true on rollback
  if (res.manifest.artifact && res.download_url) {
    const buf = await (await fetch(res.download_url)).arrayBuffer();
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== res.manifest.artifact.sha256) throw new Error("Bundle hash mismatch — ignoring");
    return { ...res.manifest, bundle: buf, downgrade: res.downgrade };
  }
  return { ...res.manifest, downgrade: res.downgrade };
}

export async function getFlags(): Promise<Record<string, boolean>> {
  const q = new URLSearchParams({ project: PROJECT, channel: CHANNEL, device: deviceId() });
  const { payload, signature } = await (await fetch(\`\${JACKBOY}/flags?\${q}\`)).json();
  if (!(await verify(payload, signature))) return {};
  return payload.flags;
}

export function reportHealth(kind: "ok" | "error" | "crash", message = "") {
  // Never include personal data in message.
  return fetch(\`\${JACKBOY}/health\`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: PROJECT, version: VERSION, channel: CHANNEL, device: deviceId(), kind, message: message.slice(0, 500) }),
  });
}

// Example wiring
window.addEventListener("error", (e) => reportHealth("error", String(e.message)));
window.addEventListener("unhandledrejection", (e) => reportHealth("error", String(e.reason)));
reportHealth("ok");
`;
