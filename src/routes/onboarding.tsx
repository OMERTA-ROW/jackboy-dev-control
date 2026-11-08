import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { claimOwner, getAccountStatus } from "@/lib/account.functions";

export const Route = createFileRoute("/onboarding")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Account setup — Jackboy" },
      { name: "description", content: "Accept your invitation or complete owner setup for Jackboy." },
      { property: "og:title", content: "Account setup — Jackboy" },
      { property: "og:description", content: "Invitation-only onboarding for Jackboy." },
    ],
  }),
  component: Onboarding,
});

type Status = { role: string | null; ownerConfigured: boolean; ownerExists: boolean };

function Onboarding() {
  const nav = useNavigate();
  const statusFn = useServerFn(getAccountStatus);
  const claimFn = useServerFn(claimOwner);
  const [email, setEmail] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const { data, error } = await supabase.auth.getUser();
    if (!data.user && isTransientAuthError(error)) return setMsg(GATE_CONNECTION_MESSAGE);
    if (!data.user) return nav({ to: "/auth" });
    setEmail(data.user.email ?? null);
    try {
      const s = await statusFn();
      if (s.role) return nav({ to: "/" });
      setStatus(s);
    } catch {
      setMsg(GATE_CONNECTION_MESSAGE);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setMsg(null);
    try { await fn(); await refresh(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto mt-10 max-w-lg space-y-4">
      <section className="panel p-6">
        <h1 className="text-xl font-semibold text-silver">Account setup</h1>
        <p className="mt-1 text-sm text-muted-foreground">Signed in as <strong>{email ?? "…"}</strong>. This account has no Jackboy access yet.</p>
        {!status ? <p className="mt-4 text-sm text-muted-foreground">Checking…</p> : (
          <div className="mt-4 space-y-4">
            {!status.ownerExists && !status.ownerConfigured && (
              <div className="rounded-md border border-warning/40 bg-muted p-3 text-sm"><strong className="text-warning">Owner setup required.</strong> The owner email has not been configured on the server. The project owner must add the <code>OWNER_EMAIL</code> secret.</div>
            )}
            {!status.ownerExists && status.ownerConfigured && (
              <div>
                <h2 className="text-sm font-semibold text-silver">Owner setup</h2>
                <p className="text-xs text-muted-foreground">Works only if your confirmed email matches the configured owner email.</p>
                <button disabled={busy} onClick={() => act(() => claimFn())} className="mt-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">Claim owner access</button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Invited? Use the invitation link you were given. If you already redeemed it, your access appears here after you verify your email.</p>
          </div>
        )}
        {msg && <p role="alert" className="mt-3 text-sm text-destructive">{msg}</p>}
        <button onClick={async () => { await supabase.auth.signOut(); nav({ to: "/auth", replace: true }); }} className="mt-6 text-xs text-muted-foreground underline">Sign out</button>
      </section>
    </div>
  );
}
