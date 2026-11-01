import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getSetupState, requestOwnerSetup } from "@/lib/account.functions";
import { Button } from "@/components/ui/button";
import { OWNER_SETUP_REQUIRED, authErrorMessage, signInVerified } from "@/lib/account-auth";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Jackboy" },
      { name: "description", content: "Private, invitation-only sign-in for Jackboy." },
      { property: "og:title", content: "Sign in — Jackboy" },
      { property: "og:description", content: "Invitation-only access to Jackboy." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
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
  const [setupError, setSetupError] = useState<string | null>(null);
  async function refreshSetup() {
    setSetupError(null);
    try { setSetup(await setupFn()); } catch { setSetupError("Owner setup status is unavailable. Retry before requesting verification."); }
  }
  useEffect(() => { void refreshSetup(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      if (mode === "in") {
        await signInVerified(supabase.auth, email, password);
        nav({ to: "/onboarding" });
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/set-password` });
        if (error) throw new Error(authErrorMessage(error));
        setMsg({ ok: true, t: "Recovery request accepted. If eligible, check your inbox and spam folder. Inbox delivery is not yet verified." });
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
        <Button disabled={busy || (mode === "owner" && (!setup?.ownerConfigured || setup.ownerExists || Boolean(setupError)))} className="h-auto min-h-9 w-full whitespace-normal">{busy ? "Working…" : mode === "in" ? "Sign in" : mode === "forgot" ? "Send recovery email" : "Send owner verification email"}</Button>
      </form>
      {msg && <p role="status" className={`mt-3 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</p>}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {mode !== "in" && <Button variant="link" size="sm" onClick={() => { setMode("in"); setMsg(null); }}>Back to sign in</Button>}
        {mode !== "forgot" && <Button variant="link" size="sm" onClick={() => { setMode("forgot"); setMsg(null); }}>Forgot password?</Button>}
        {setup && !setup.ownerExists && mode !== "owner" && <Button variant="link" size="sm" onClick={() => { setMode("owner"); setMsg(null); }}>First-time owner setup</Button>}
      </div>
      {setupError && <p role="alert" className="mt-3 text-xs text-warning">{setupError}</p>}
      {setup && !setup.ownerExists && <div className="mt-4 border-t border-border pt-4 text-xs">
        <h2 className="font-semibold text-silver">Owner setup status</h2>
        <p className="mt-2 text-muted-foreground">Owner identity: {setup.ownerConfigured ? "Configured" : "Missing"}. Owner access: not claimed.</p>
        {!setup.ownerConfigured && <p role="status" className="mt-2 text-warning">{OWNER_SETUP_REQUIRED}</p>}
        <p className="mt-2 text-muted-foreground">Auth email delivery: not yet verified. Standard authentication emails use Lovable Cloud’s default sender; a custom domain is optional.</p>
        <p className="mt-2 text-muted-foreground">After configuring your owner email, refresh status, request verification, open the email link, set your password, then claim owner access. Existing accounts can still sign in above.</p>
      </div>}
      <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => void refreshSetup()}>Refresh setup status</Button>
    </section>
  );
}
