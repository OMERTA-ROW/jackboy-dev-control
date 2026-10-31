import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getSetupState, requestOwnerSetup } from "@/lib/account.functions";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Jackboy" },
      { name: "description", content: "Private, invitation-only sign-in for Jackboy." },
      { property: "og:title", content: "Sign in — Jackboy" },
      { property: "og:description", content: "Invitation-only access to Jackboy." },
    ],
  }),
  component: AuthPage,
});

const input = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function AuthPage() {
  const nav = useNavigate();
  const setupFn = useServerFn(getSetupState);
  const ownerFn = useServerFn(requestOwnerSetup);
  const [mode, setMode] = useState<"in" | "forgot" | "owner">("in");
  const [setup, setSetup] = useState<{ ownerConfigured: boolean; ownerExists: boolean } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  useEffect(() => { void setupFn().then(setSetup).catch(() => {}); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        nav({ to: "/onboarding" });
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/set-password` });
        if (error) throw error;
        setMsg({ ok: true, t: "If an account exists, a recovery email has been sent." });
      } else {
        setMsg({ ok: true, t: (await ownerFn({ data: { email } })).message });
      }
    } catch (err) { setMsg({ ok: false, t: (err as Error).message }); } finally { setBusy(false); }
  }

  return (
    <section className="panel mx-auto mt-10 max-w-sm p-6" aria-labelledby="auth-h">
      <h1 id="auth-h" className="flex items-center gap-2 text-xl font-semibold text-silver"><Lock className="h-4 w-4" />{mode === "in" ? "Sign in" : mode === "forgot" ? "Recover password" : "Owner setup"}</h1>
      <p className="mt-1 text-xs text-muted-foreground">Registration is closed. Accounts are created only from an owner invitation link.</p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <label className="block text-sm">Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} /></label>
        {mode === "in" && <label className="block text-sm">Password<input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} /></label>}
        <button disabled={busy} className="w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? "Working…" : mode === "in" ? "Sign in" : mode === "forgot" ? "Send recovery email" : "Send owner verification email"}</button>
      </form>
      {msg && <p role="status" className={`mt-3 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</p>}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {mode !== "in" && <button onClick={() => { setMode("in"); setMsg(null); }} className="text-electric underline">Back to sign in</button>}
        {mode !== "forgot" && <button onClick={() => { setMode("forgot"); setMsg(null); }} className="text-electric underline">Forgot password?</button>}
        {setup && !setup.ownerExists && mode !== "owner" && <button onClick={() => { setMode("owner"); setMsg(null); }} className="text-electric underline">First-time owner setup</button>}
      </div>
      {setup && !setup.ownerExists && !setup.ownerConfigured && <p className="mt-3 text-xs text-warning">Owner setup is waiting for the OWNER_EMAIL server secret.</p>}
    </section>
  );
}
