import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/update-docs")({
  head: () => ({
    meta: [
      { title: "Update client docs — Jackboy" },
      { name: "description", content: "Copy-paste code for projects to check Jackboy for signed updates, flags and send health reports." },
      { property: "og:title", content: "Update client docs — Jackboy" },
      { property: "og:description", content: "How a project checks for updates and feature flags and verifies Jackboy's signature." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Docs,
});

const snippet = (origin: string) => `// jackboy-updates.ts — drop into any web project
const JACKBOY = "${origin}/api/public/updates";
const PROJECT = "jbp_YOUR_CLIENT_KEY";   // from Jackboy → Releases
const CHANNEL = "live";                  // "test" | "beta" | "live"
const VERSION = "1.0.0";                 // this build's version
const PUBLIC_KEY = "PASTE_PUBLIC_KEY";   // from Jackboy → Releases (or GET /public-key once, then pin it)

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

function Docs() {
  const origin = typeof window === "undefined" ? "https://jackboy-dev-control.lovable.app" : window.location.origin;
  const code = snippet(origin);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-6">
      <PageHeader title="Update client docs" subtitle="How a project checks Jackboy for signed updates and feature flags, and reports its health." />
      <section className="hex-panel space-y-2 rounded-lg border border-border p-4 text-sm">
        <h2 className="font-semibold">Endpoints</h2>
        <ul className="list-disc space-y-1 pl-5 font-mono text-xs">
          <li>GET /api/public/updates/check?project&version&channel&device</li>
          <li>GET /api/public/updates/flags?project&channel&device</li>
          <li>POST /api/public/updates/health {"{ project, version, channel, device, kind, message }"}</li>
          <li>GET /api/public/updates/public-key</li>
        </ul>
        <p className="text-muted-foreground">Every manifest and flag response is signed with Ed25519. Verify with the public key on <Link to="/releases" className="text-electric underline">Releases</Link> and reject anything that fails. Rollouts use a stable per-device bucket; if a release is rolled back, check returns the previous version with <code>downgrade: true</code>.</p>
        <p className="text-muted-foreground">Note: the published site must be reachable for external projects to call these endpoints.</p>
      </section>
      <section className="hex-panel rounded-lg border border-border p-4">
        <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Client snippet (TypeScript)</h2>
          <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric" onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button></div>
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-background p-3 text-xs"><code>{code}</code></pre>
      </section>
    </div>
  );
}
