import { createFileRoute } from "@tanstack/react-router";
import { Github, Code2, Hexagon, Terminal, Circle, Blocks } from "lucide-react";
import { PageHeader } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/integrations")({
  head: () => ({
    meta: [
      { title: "Integrations — Jackboy" },
      { name: "description", content: "Setup status for GitHub, VS Code, OMNI and Honeycomb Terminal." },
      { property: "og:title", content: "Integrations — Jackboy" },
      { property: "og:description", content: "Connect Jackboy to your tools when ready." },
    ],
  }),
  component: Integrations,
});

const ITEMS = [
  {
    name: "Lovable deployment API",
    icon: Blocks,
    scope:
      "Reads only registered Lovable project references. Can inspect published status, latest preview metadata and publish status; production publishing is owner/passkey-gated.",
    needs: [
      "Lovable Business or Enterprise workspace and a dedicated server-side key with projects:read and projects:write",
      "Registered Lovable project references and linked GitHub Actions for exact-commit build verification",
      "Rollback requires manual version restore in Lovable; the documented API has no rollback endpoint",
    ],
  },
  {
    name: "GitHub",
    icon: Github,
    scope: "Read-only repo access, CI status, pull-request diagnostics.",
    needs: [
      "A GitHub App or OAuth app owned by you",
      "Repository selection (least privilege)",
      "Lovable Cloud for secure token storage",
    ],
  },
  {
    name: "VS Code",
    icon: Code2,
    scope: "Send diagnostics from your editor to Jackboy.",
    needs: ["A VS Code extension (not yet built)", "Per-device pairing token"],
  },
  {
    name: "OMNI",
    icon: Hexagon,
    scope: "Authorized build/test/deploy engine. Receives approved handoffs from Jackboy.",
    needs: ["OMNI API endpoint & API credentials", "Confirmation of which OMNI service this refers to"],
  },
  {
    name: "Honeycomb Terminal",
    icon: Terminal,
    scope: "Read-only status from your Honeycomb Terminal project.",
    needs: ["A documented read-only API from that project", "Jackboy will not modify Honeycomb Terminal"],
  },
];

function Integrations() {
  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="External development integrations below are disconnected. Each connection needs an owner-approved scope and a live verification before Jackboy uses it."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {ITEMS.map(({ name, icon: Icon, scope, needs }) => (
          <article key={name} className="panel p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="hex-clip flex h-10 w-10 items-center justify-center bg-secondary">
                  <Icon className="h-5 w-5 text-silver" aria-hidden />
                </div>
                <h2 className="text-lg font-semibold text-silver">{name}</h2>
              </div>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Circle className="h-2 w-2 fill-current" />
                Not connected
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">{scope}</p>
            <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-silver-dim">Prerequisites</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {needs.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Credentials are never stored in code. When integrations are added, keys will live in a server-side secret store.
      </p>
    </>
  );
}
