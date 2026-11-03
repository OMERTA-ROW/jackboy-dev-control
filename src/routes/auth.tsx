import { lovable } from "@/integrations/lovable/index";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Lock, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getSetupState, requestOwnerSetup } from "@/lib/account.functions";
import { redeemRecoveryCode } from "@/lib/recovery.functions";
import { Button } from "@/components/ui/button";
import {
  OWNER_SETUP_REQUIRED, signInVerified, signupErrorMessage,
  mfaChallengeRequired, cooldownRemaining, passwordProblem,
} from "@/lib/account-auth";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — Jackboy" },
      { name: "description", content: "Private, owner-controlled sign-in for Jackboy." },
      { property: "og:title", content: "Sign in — Jackboy" },
      { property: "og:description", content: "Owner and invitation-only access to Jackboy." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

type Mode = "in" | "up" | "forgot" | "owner" | "mfa";
type Providers = Record<string, boolean>;
const input = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-electric";
const SOCIAL: { id: string; key: string; label: string; supported: boolean }[] = [
  { id: "google", key: "google", label: "Google", supported: true },
  { id: "microsoft", key: "azure", label: "Microsoft", supported: true },
  { id: "github", key: "github", label: "GitHub", supported: true },
];
// GitHub sign-in is federated through the owner's Auth0 tenant over the OIDC slot
// "custom:app-oidc". The owner enabled it in Cloud auth settings; the backend's public
// settings endpoint does not report custom OIDC, so this flag is owner-confirmed rather
// than read from config. Flip it back to false if the provider is ever removed.
const AUTH0_OIDC_READY = true;

function AuthPage() {
  const nav = useNavigate();
  const setupFn = useServerFn(getSetupState);
  const ownerFn = useServerFn(requestOwnerSetup);
  const redeemFn = useServerFn(redeemRecoveryCode);
  const [useBackup, setUseBackup] = useState(false);
  const [mode, setMode] = useState<Mode>("in");
  const [setup, setSetup] = useState<{ ownerConfigured: boolean; ownerExists: boolean } | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [signupOpen, setSignupOpen] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastSent, setLastSent] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  async function refreshSetup() {
    setSetupError(null);
    try { setSetup(await setupFn()); } catch { setSetupError("Owner setup status is unavailable. Retry before requesting verification."); }
  }
  useEffect(() => {
    void refreshSetup();
    // Public, non-secret Auth settings: which providers are actually enabled.
    const url = import.meta.env["VITE_SUPABASE_URL"] as string;
    const key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string;
    fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((r) => r.json())
      .then((s: { external?: Providers; disable_signup?: boolean }) => { setProviders(s.external ?? {}); setSignupOpen(!s.disable_signup); })
      .catch(() => setProviders({}));
    // Already signed in (and stepped up if required) → continue.
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (mfaChallengeRequired(aal)) setMode("mfa"); else nav({ to: "/onboarding" });
    });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const wait = cooldownRemaining(lastSent, now);
  function go(m: Mode) { setMode(m); setMsg(null); }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      if (mode === "in") {
        await signInVerified(supabase.auth, email, password);
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (mfaChallengeRequired(aal)) { go("mfa"); return; }
        nav({ to: "/onboarding" });
      } else if (mode === "mfa") {
        if (useBackup) {
          await redeemFn({ data: { code } });
          nav({ to: "/security" });
          return;
        }
        const { data: f, error: fe } = await supabase.auth.mfa.listFactors();
        if (fe) throw new Error(fe.message);
        const factor = f.totp.find((x) => x.status === "verified");
        if (!factor) throw new Error("No verified authenticator found. Sign out and contact the owner.");
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
        if (error) throw new Error(/invalid|expired/i.test(error.message) ? "That code is incorrect or expired. Enter the current 6-digit code." : error.message);
        nav({ to: "/onboarding" });
      } else if (mode === "up") {
        const p = passwordProblem(password, confirm);
        if (p) throw new Error(p);
        if (wait) throw new Error(`Please wait ${wait}s before trying again.`);
        const { error } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: `${window.location.origin}/onboarding` } });
        setLastSent(Date.now());
        if (error) throw new Error(signupErrorMessage(error));
        setMsg({ ok: true, t: "Check your email to confirm your address. Confirmed accounts have no access until the owner grants it by invitation." });
      } else if (mode === "forgot") {
        if (wait) throw new Error(`Please wait ${wait}s before requesting another email.`);
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/set-password` });
        setLastSent(Date.now());
        if (error) throw new Error(signupErrorMessage(error));
        setMsg({ ok: true, t: "If an account exists for that email, a reset link is on its way. Check your inbox and spam folder." });
      } else {
        setMsg({ ok: true, t: (await ownerFn({ data: { email } })).message });
      }
    } catch (err) { setMsg({ ok: false, t: (err as Error).message }); } finally { setBusy(false); }
  }

  async function cancelMfa() { await supabase.auth.signOut(); go("in"); }

  const title = { in: "Sign in", up: "Create account", forgot: "Reset password", owner: "Owner setup", mfa: "Two-step verification" }[mode];
  return (
    <section className="panel mx-auto mt-10 max-w-sm p-6" aria-labelledby="auth-h">
      <h1 id="auth-h" className="flex items-center gap-2 text-xl font-semibold text-silver">
        {mode === "mfa" ? <ShieldCheck className="h-4 w-4 text-electric" /> : <Lock className="h-4 w-4 text-electric" />}{title}
      </h1>
      <p className="mt-1 text-xs text-muted-foreground">
        {mode === "mfa" ? "Enter the 6-digit code from Google Authenticator or another authenticator app."
          : "Access is owner-controlled. New accounts get no access until invited by the owner."}
      </p>

      {(mode === "in" || mode === "up") && (
        <div className="mt-4 space-y-2">
          {SOCIAL.map((p) => {
            const enabled = p.id === "github" ? AUTH0_OIDC_READY : p.supported && providers?.[p.key] === true;
            const why = p.id === "github" && !AUTH0_OIDC_READY ? "Waiting for owner setup" : providers === null ? "Checking…" : "Not enabled yet by the owner";
            return (
              <Button key={p.id} type="button" variant="outline" className="w-full justify-between" disabled={!enabled || busy}
                title={enabled ? undefined : why} aria-describedby={`${p.id}-why`}
                onClick={async () => {
                  setBusy(true); setMsg(null);
                  if (p.id === "github") {
                    const { error } = await supabase.auth.signInWithOAuth({ provider: "custom:app-oidc" as never, options: { redirectTo: `${window.location.origin}/auth` } });
                    if (error) { setMsg({ ok: false, t: `GitHub sign-in failed: ${error.message}` }); setBusy(false); }
                    return;
                  }
                  const r = await lovable.auth.signInWithOAuth(p.id as "google" | "microsoft", { redirect_uri: `${window.location.origin}/auth` });
                  if (r.error) { setMsg({ ok: false, t: `${p.label} sign-in failed: ${r.error.message}` }); setBusy(false); return; }
                  if (r.redirected) return;
                  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
                  setBusy(false);
                  if (mfaChallengeRequired(aal)) setMode("mfa"); else nav({ to: "/onboarding" });
                }}>
                <span>Continue with {p.label}</span>
                {!enabled && <span id={`${p.id}-why`} className="text-[10px] text-muted-foreground">{why}</span>}
              </Button>
            );
          })}
          <div className="flex items-center gap-2 pt-1 text-[10px] uppercase tracking-widest text-muted-foreground"><span className="h-px flex-1 bg-border" />or email<span className="h-px flex-1 bg-border" /></div>
        </div>
      )}

      <form onSubmit={submit} className="mt-3 space-y-3">
        {mode !== "mfa" && <label className="block text-sm">Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} /></label>}
        {(mode === "in" || mode === "up") && <label className="block text-sm">Password<input required type="password" minLength={mode === "up" ? 10 : undefined} autoComplete={mode === "up" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} className={input} /></label>}
        {mode === "up" && <label className="block text-sm">Confirm password<input required type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} /></label>}
        {mode === "mfa" && useBackup && <label className="block text-sm">Recovery code<input required autoComplete="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" className={`${input} font-mono tracking-widest`} /></label>}
        {mode === "mfa" && !useBackup && <label className="block text-sm">Authentication code<input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className={`${input} tracking-[0.5em]`} /></label>}
        {mode === "up" && signupOpen === false && <p className="text-xs text-warning">Open registration is currently off; only invited people can create accounts.</p>}
        <Button disabled={busy || ((mode === "forgot" || mode === "up") && wait > 0) || (mode === "owner" && (!setup?.ownerConfigured || setup.ownerExists || Boolean(setupError)))} className="h-auto min-h-9 w-full whitespace-normal">
          {busy ? "Working…" : wait > 0 && (mode === "forgot" || mode === "up") ? `Try again in ${wait}s`
            : { in: "Sign in", up: "Create account", forgot: "Send reset link", owner: "Send owner verification email", mfa: "Verify" }[mode]}
        </Button>
      </form>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-3 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</p>}

      <div className="mt-4 flex flex-wrap gap-x-3 text-xs">
        {mode === "mfa" ? <>
          <Button variant="link" size="sm" onClick={() => { setUseBackup(!useBackup); setCode(""); setMsg(null); }}>{useBackup ? "Use authenticator code" : "Lost your authenticator? Use a recovery code"}</Button>
          <Button variant="link" size="sm" onClick={() => void cancelMfa()}>Cancel and sign out</Button>
        </> : <>
          {mode !== "in" && <Button variant="link" size="sm" onClick={() => go("in")}>Back to sign in</Button>}
          {mode !== "up" && <Button variant="link" size="sm" onClick={() => go("up")}>Create account</Button>}
          {mode !== "forgot" && <Button variant="link" size="sm" onClick={() => go("forgot")}>Forgot password?</Button>}
          {setup && !setup.ownerExists && mode !== "owner" && <Button variant="link" size="sm" onClick={() => go("owner")}>First-time owner setup</Button>}
        </>}
      </div>
      {setupError && <p role="alert" className="mt-3 text-xs text-warning">{setupError}</p>}
      {mode === "owner" && setup && !setup.ownerExists && <div className="mt-4 border-t border-border pt-4 text-xs">
        <p className="text-muted-foreground">Owner identity: {setup.ownerConfigured ? "Configured" : "Missing"}. Owner access: not claimed.</p>
        {!setup.ownerConfigured && <p role="status" className="mt-2 text-warning">{OWNER_SETUP_REQUIRED}</p>}
        <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => void refreshSetup()}>Refresh setup status</Button>
      </div>}
    </section>
  );
}
