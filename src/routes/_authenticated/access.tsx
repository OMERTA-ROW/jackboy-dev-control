import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Lock, UserPlus, ShieldCheck, Eye, LogOut } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { createInvite } from "@/lib/account.functions";

export const Route = createFileRoute("/_authenticated/access")({
  head: () => ({
    meta: [
      { title: "Access & Security — Jackboy" },
      { name: "description", content: "Owner-managed invitations, roles, sessions and audit log for Jackboy." },
      { property: "og:title", content: "Access & Security — Jackboy" },
      { property: "og:description", content: "Private-first access model for Jackboy." },
    ],
  }),
  component: Access,
});

const BOUNDARIES = [
  { icon: Eye, t: "Invitation-only", d: "Open registration is disabled. Accounts come only from single-use, expiring invitation links plus email verification." },
  { icon: Lock, t: "Server-side checks", d: "Roles are verified by the database and server functions, not just by the page." },
  { icon: ShieldCheck, t: "Secrets stay on the server", d: "Search API keys live in server secrets and are never sent to the browser." },
];

function Access() {
  const { role, user } = Route.useRouteContext();
  const qc = useQueryClient();
  const nav = useNavigate();
  const manager = role === "owner" || role === "admin";
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const inviteFn = useServerFn(createInvite);
  const [link, setLink] = useState<string | null>(null);

  const members = useQuery({ queryKey: ["members"], enabled: manager, queryFn: async () => (await supabase.from("user_roles").select("user_id, role, created_at").order("created_at")).data ?? [] });
  const invites = useQuery({ queryKey: ["invites"], enabled: manager, queryFn: async () => (await supabase.from("invitations").select("*").order("created_at", { ascending: false }).limit(50)).data ?? [] });
  const audit = useQuery({ queryKey: ["audit"], queryFn: async () => (await supabase.from("audit_logs").select("*").order("at", { ascending: false }).limit(30)).data ?? [] });

  async function rpc(fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setMsg(null);
    const { error } = await fn();
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: ok });
    void qc.invalidateQueries();
  }

  async function signOut(scope: "local" | "global") {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut({ scope });
    nav({ to: "/auth", replace: true });
  }

  return (
    <>
      <PageHeader title="Access & Security" subtitle="Private, invitation-only accounts managed by the owner." />
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted p-4 text-sm">
        <span>Signed in as <strong>{user.email}</strong> · role <strong className="text-electric">{role}</strong></span>
        <button onClick={() => signOut("local")} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs"><LogOut className="h-3.5 w-3.5" />Sign out</button>
        <button onClick={() => signOut("global")} className="rounded-md border border-destructive/50 px-3 py-1.5 text-xs text-destructive">Sign out all devices</button>
      </div>
      {msg && <p role="status" className={`mb-4 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</p>}

      {manager ? (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="panel p-5" aria-labelledby="inv">
            <h2 id="inv" className="flex items-center gap-2 text-lg font-semibold text-silver"><UserPlus className="h-4 w-4" />Invite</h2>
            <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); setMsg(null); setLink(null); inviteFn({ data: { email, role: inviteRole } }).then((r) => { setLink(r.link); setMsg({ ok: true, t: `Single-use invitation created for ${email}; expires in ${r.expiresInDays} days. Copy the link now — it is shown only once.` }); setEmail(""); void qc.invalidateQueries(); }).catch((err) => setMsg({ ok: false, t: (err as Error).message })); }}>
              <label className="block text-sm">Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
              <label className="block text-sm">Role
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "member" | "admin")} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  <option value="member">Member</option>
                  {role === "owner" && <option value="admin">Admin</option>}
                </select>
              </label>
              <button className="w-full rounded-md bg-primary py-2 text-sm text-primary-foreground">Create invitation</button>
            </form>
            {link && <div className="mt-3 rounded border border-electric/50 p-2 text-xs"><div className="break-all font-mono">{link}</div><button type="button" onClick={() => navigator.clipboard.writeText(link)} className="mt-1 text-electric underline">Copy link</button></div>}
            <p className="mt-2 text-xs text-muted-foreground">Send the link privately to the invitee. Opening it emails a verification link to the invited address only.</p>
            <ul className="mt-4 space-y-2 text-sm">
              {(invites.data ?? []).map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
                  <span className="min-w-0 truncate">{i.email} · {i.role} · <span className={i.status === "accepted" ? "text-success" : i.status === "revoked" ? "text-destructive" : "text-warning"}>{i.status === "pending" && new Date(i.expires_at) < new Date() ? "expired" : i.status}</span></span>
                  {i.status === "pending" && <button onClick={() => rpc(() => supabase.rpc("revoke_invitation", { _id: i.id }), "Invitation revoked.")} className="text-xs text-destructive underline">Revoke</button>}
                </li>
              ))}
            </ul>
          </section>
          <section className="panel p-5" aria-labelledby="mem">
            <h2 id="mem" className="text-lg font-semibold text-silver">Members</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {(members.data ?? []).map((m) => (
                <li key={m.user_id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
                  <span className="truncate font-mono text-xs">{m.user_id === user.id ? "You" : m.user_id.slice(0, 8)} · {m.role}</span>
                  {role === "owner" && m.role !== "owner" && <button onClick={() => rpc(() => supabase.rpc("remove_member", { _user_id: m.user_id }), "Access removed.")} className="text-xs text-destructive underline">Remove</button>}
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : <p className="text-sm text-muted-foreground">Members can't manage invitations. Ask the owner for changes.</p>}

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-silver">Audit log (server)</h2>
      <ul className="panel divide-y divide-border text-xs">
        {(audit.data ?? []).length === 0 && <li className="p-3 text-muted-foreground">No entries yet.</li>}
        {(audit.data ?? []).map((a) => (
          <li key={a.id} className="flex flex-wrap gap-2 p-3"><span className="text-muted-foreground">{new Date(a.at).toLocaleString()}</span><span className="font-mono">{a.action}</span><span className={a.outcome === "ok" ? "text-success" : "text-warning"}>{a.outcome}</span><span className="truncate text-muted-foreground">{JSON.stringify(a.detail)}</span></li>
        ))}
      </ul>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-silver">Security boundaries</h2>
      <ul className="grid gap-3 md:grid-cols-3">
        {BOUNDARIES.map(({ icon: I, t, d }) => (
          <li key={t} className="panel p-4"><I className="h-4 w-4 text-success" aria-hidden /><div className="mt-2 text-sm font-medium">{t}</div><div className="text-xs text-muted-foreground">{d}</div></li>
        ))}
      </ul>
    </>
  );
}
