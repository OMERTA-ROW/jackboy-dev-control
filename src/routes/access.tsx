import { createFileRoute } from "@tanstack/react-router";
import { Lock, UserPlus, ShieldCheck, Eye } from "lucide-react";
import { PageHeader } from "@/components/AppShell";

export const Route = createFileRoute("/access")({
  head: () => ({
    meta: [
      { title: "Access & Security — Jackboy" },
      { name: "description", content: "Owner login, invites and security boundaries for Jackboy." },
      { property: "og:title", content: "Access & Security — Jackboy" },
      { property: "og:description", content: "Private-first access model for Jackboy." },
    ],
  }),
  component: Access,
});

const BOUNDARIES = [
  { icon: Eye, t: "Read-only by default", d: "No connected source can be written to without a logged approval." },
  { icon: Lock, t: "No hardcoded credentials", d: "Secrets belong in a server-side vault, never in the app." },
  { icon: ShieldCheck, t: "Local-only learning", d: "Usage learning is opt-in and stays in this browser until accounts exist." },
];

function Access() {
  return (
    <>
      <PageHeader title="Access & Security" subtitle="Jackboy is designed to be private to its owner and invited teammates." />
      <div className="mb-6 rounded-md border border-warning/40 bg-muted p-4 text-sm">
        <strong className="text-warning">Accounts are not enabled yet.</strong>{" "}
        Owner login and invites need a secure backend (Lovable Cloud). Until it's turned on, this app has no sign-in and should not be published with private data.
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="panel p-5" aria-labelledby="own">
          <h2 id="own" className="flex items-center gap-2 text-lg font-semibold text-silver"><Lock className="h-4 w-4" />Owner sign-in</h2>
          <form className="mt-4 space-y-3" onSubmit={(e) => e.preventDefault()} aria-describedby="own-note">
            <label className="block text-sm">Email<input disabled type="email" className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
            <button disabled className="w-full cursor-not-allowed rounded-md border border-border py-2 text-sm text-muted-foreground">Sign in (unavailable)</button>
          </form>
          <p id="own-note" className="mt-2 text-xs text-muted-foreground">Will activate once accounts are enabled.</p>
        </section>
        <section className="panel p-5" aria-labelledby="inv">
          <h2 id="inv" className="flex items-center gap-2 text-lg font-semibold text-silver"><UserPlus className="h-4 w-4" />Invite teammates</h2>
          <p className="mt-4 text-sm text-muted-foreground">Planned: the owner invites by email; invitees get read-only access unless granted more. Roles are stored separately from profiles.</p>
        </section>
      </div>
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-silver">Security boundaries</h2>
      <ul className="grid gap-3 md:grid-cols-3">
        {BOUNDARIES.map(({ icon: I, t, d }) => (
          <li key={t} className="panel p-4"><I className="h-4 w-4 text-success" aria-hidden /><div className="mt-2 text-sm font-medium">{t}</div><div className="text-xs text-muted-foreground">{d}</div></li>
        ))}
      </ul>
    </>
  );
}
