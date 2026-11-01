import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { clientSnippet } from "@/lib/update-client-snippet";

const snippet = (origin: string) => clientSnippet(origin);

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
