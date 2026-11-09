import { GUIDELINES } from "@/lib/guidelines";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PasskeyPanel } from "@/components/PasskeyPanel";
import { GitHubTokenPanel } from "@/components/GitHubTokenPanel";
import { GitHubAppPanel } from "@/components/GitHubAppPanel";
import { RepositorySyncPanel } from "@/components/RepositorySync";
import { CodeSafetyPanel } from "@/components/CodeSafetyPanel";
import { CodeSitesList } from "@/components/CodeSiteCard";
import { CodeLanePanel } from "@/components/CodeLanePanel";
import { TaskSkipRules } from "@/components/TaskSkipRules";
import { CapabilitiesPanel } from "@/components/CapabilitiesPanel";
import { AutonomyStatusPanel } from "@/components/AutonomyStatusPanel";
import { GuardianPanel } from "@/components/GuardianPanel";
import { ShieldCheck } from "lucide-react";
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
    { to: "/tasks", label: "Task Mode", note: "Plain-words tasks with live progress and passkey checkpoints" },
    { to: "/foundry", label: "Code Foundry", note: "Inspect → patch → test → approve → draft PR, with full history" },
    { to: "/blockers", label: "Blocker Queue", note: "What's stopping each connected project, and the fix" },
    { to: "/autopilot", label: "Autopilot", note: "Main switch, per-project switches, scan reports" },
    { to: "/releases", label: "Releases", note: "Versions, staged rollouts, feature switches" },
    { to: "/update-docs", label: "Update Docs", note: "Code projects use to check for updates" },
    { to: "/feeds", label: "Live Feeds", note: "News and change sources for update writing" },
    { to: "/automation", label: "Automation policy", note: "Approval tiers and playbooks" },
  ] },
  { group: "Agents & partners", items: [
    { to: "/settings", hash: "guardian", label: "Guardian", note: "What Guardian protects, its rules, recent decisions and owner settings" },
    { to: "/agents", label: "Agent Hub", note: "Registered Lovable projects, reports, keys" },
    { to: "/fleet", label: "Agent Fleet", note: "Capabilities and emergency pause" },
    { to: "/omni", label: "OMNI", note: "Build task queue and OMNI link values for Railway (not connected)" },
    { to: "/jax", label: "JAX", note: "Not connected" },
    { to: "/razul", label: "RA'SUL", note: "Intelligence feed (not connected unless configured)" },
  ] },
  { group: "Research", items: [
    { to: "/discovery", label: "Discovery", note: "No sources connected" },
    { to: "/research", label: "Research", note: "Web search (needs search key)" },
    { to: "/workspace", label: "Inspect", note: "Local code diagnostics" },
  ] },
  { group: "Account & records", items: [
    { to: "/overview", label: "Advanced overview", note: "Previous dashboard with all counts" },
    { to: "/reports", label: "Reports, alerts & Undo", note: "Morning report, phone alerts, and one-press Undo for CODE changes" },
    { to: "/site-log", label: "Site Log & Research", note: "Permanent log, export, report delivery, code research" },
    { to: "/activity", label: "Logs & Approvals", note: "Audit trail" },
    { to: "/autoconnect", label: "AutoConnect", note: "Approve & connect missing tools per project; resumes waiting work" },
      {
        to: "/provider-access",
        label: "Provider access",
        note: "Review GitHub App permissions and audit owner-approved requests",
      },
      {
        to: "/deployments",
        label: "Deployments",
        note: "Verify builds, inspect previews, publish with owner approval",
      },
    { to: "/accounts", label: "Connect Accounts", note: "Live status, scopes, where credentials live, revoke" },
    { to: "/integrations", label: "Integrations", note: "Connection status and setup" },
    { to: "/access", label: "Access", note: "Members, invitations, sessions" },
  ] },
] as const;

function Settings() {
  return (
    <>
      <PageHeader title="Settings & Advanced" subtitle="Every advanced Jackboy tool, grouped. Your everyday flow lives on Home and Projects." />
      <nav aria-label="Jump to" className="mb-4 flex flex-wrap gap-2 text-xs">
        <Link to="/settings" hash="guardian" className="inline-flex items-center gap-1 rounded-md border border-electric px-3 py-1.5 font-medium text-electric hover:bg-muted">
          <ShieldCheck className="h-4 w-4" aria-hidden /> Guardian
        </Link>
        <Link to="/settings" hash="activation" className="inline-flex items-center rounded-md border border-border px-3 py-1.5 font-medium hover:border-electric">Activation & Kill Switch</Link>
      </nav>
      <CodeSafetyPanel />
      <AutonomyStatusPanel />
      <GuardianPanel />
      <CodeSitesList />
      <CodeLanePanel />
      <TaskSkipRules />
      <section aria-labelledby="guidelines" className="mb-6 rounded-lg border border-border bg-card p-4">
        <h2 id="guidelines" className="text-sm font-semibold uppercase tracking-wider text-silver">Guidelines</h2>
        <p className="mt-1 text-xs text-muted-foreground">Jackboy's autonomous operating rules. If a task conflicts with them, the rules win.</p>
        <ol className="mt-3 space-y-2 text-sm">
          {GUIDELINES.map((g, i) => <li key={g.title}><span className="font-medium">{i + 1}. {g.title}.</span> <span className="text-muted-foreground">{g.rule}</span></li>)}
        </ol>
      </section>
      <CapabilitiesPanel />
      <PasskeyPanel />
      <GitHubAppPanel />
      <GitHubTokenPanel />
      <RepositorySyncPanel />
      <div className="grid gap-4 md:grid-cols-2">
        {ADVANCED.map((g) => (
          <section key={g.group} className="panel p-5" aria-labelledby={`g-${g.group}`}>
            <h2 id={`g-${g.group}`} className="text-sm font-semibold uppercase tracking-wider text-silver">{g.group}</h2>
            <ul className="mt-3 space-y-1">
              {g.items.map((i) => (
                <li key={i.to + ("hash" in i ? i.hash : "")}>
                  <Link to={i.to} {...("hash" in i ? { hash: i.hash } : {})} className="block rounded-md p-2 hover:bg-muted">
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
