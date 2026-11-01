import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings & Advanced — Jackboy" },
      { name: "description", content: "Advanced Jackboy controls: Autopilot, releases, agents, research, logs, integrations and access." },
      { property: "og:title", content: "Settings & Advanced — Jackboy" },
      { property: "og:description", content: "All advanced Jackboy tools in one place." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Settings,
});

export const ADVANCED = [
  { group: "Automation", items: [
    { to: "/foundry", label: "Code Foundry", note: "Inspect → patch → test → approve → draft PR, with full history" },
    { to: "/autopilot", label: "Autopilot", note: "Main switch, per-project switches, scan reports" },
    { to: "/releases", label: "Releases", note: "Versions, staged rollouts, feature switches" },
    { to: "/update-docs", label: "Update Docs", note: "Code projects use to check for updates" },
    { to: "/feeds", label: "Live Feeds", note: "News and change sources for update writing" },
    { to: "/automation", label: "Automation policy", note: "Approval tiers and playbooks" },
  ] },
  { group: "Agents & partners", items: [
    { to: "/agents", label: "Agent Hub", note: "Registered Lovable projects, reports, keys" },
    { to: "/fleet", label: "Agent Fleet", note: "Capabilities and emergency pause" },
    { to: "/omni", label: "OMNI", note: "Build task queue (not connected)" },
    { to: "/jax", label: "JAX", note: "Release manifests (simulated)" },
    { to: "/razul", label: "RA'SUL", note: "Intelligence feed (not connected unless configured)" },
  ] },
  { group: "Research", items: [
    { to: "/discovery", label: "Discovery", note: "Technology discovery (demo data)" },
    { to: "/research", label: "Research", note: "Web search (needs search key)" },
    { to: "/workspace", label: "Inspect", note: "Local code diagnostics" },
  ] },
  { group: "Account & records", items: [
    { to: "/overview", label: "Advanced overview", note: "Previous dashboard with all counts" },
    { to: "/activity", label: "Logs & Approvals", note: "Audit trail" },
    { to: "/accounts", label: "Connect Accounts", note: "Live status, scopes, where credentials live, revoke" },
    { to: "/integrations", label: "Integrations", note: "Connection status and setup" },
    { to: "/access", label: "Access", note: "Members, invitations, sessions" },
  ] },
] as const;

function Settings() {
  return (
    <>
      <PageHeader title="Settings & Advanced" subtitle="Every advanced Jackboy tool, grouped. Your everyday flow lives on Home and Projects." />
      <div className="grid gap-4 md:grid-cols-2">
        {ADVANCED.map((g) => (
          <section key={g.group} className="panel p-5" aria-labelledby={`g-${g.group}`}>
            <h2 id={`g-${g.group}`} className="text-sm font-semibold uppercase tracking-wider text-silver">{g.group}</h2>
            <ul className="mt-3 space-y-1">
              {g.items.map((i) => (
                <li key={i.to}>
                  <Link to={i.to} className="block rounded-md p-2 hover:bg-muted">
                    <span className="text-sm font-medium">{i.label}</span>
                    <span className="block text-xs text-muted-foreground">{i.note}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
