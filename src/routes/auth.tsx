import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

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

function AuthPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    if (mode === "in") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) return setMsg({ kind: "err", text: error.message });
      nav({ to: "/onboarding" });
    } else {
      const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/onboarding` } });
      setBusy(false);
      if (error) return setMsg({ kind: "err", text: error.message });
      setMsg({ kind: "ok", text: "Check your email to confirm your address, then sign in. Access is granted only to the owner or invited emails." });
    }
  }

  return (
    <div className="mx-auto mt-10 max-w-sm">
      <section className="panel p-6" aria-labelledby="auth-h">
        <h1 id="auth-h" className="flex items-center gap-2 text-xl font-semibold text-silver"><Lock className="h-4 w-4" />{mode === "in" ? "Sign in" : "Create account"}</h1>
        <p className="mt-1 text-xs text-muted-foreground">Jackboy is invitation-only. Creating an account does not grant access without an invitation or owner setup.</p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block text-sm">Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
          <label className="block text-sm">Password<input required minLength={10} type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
          <button disabled={busy} className="w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? "Working…" : mode === "in" ? "Sign in" : "Create account"}</button>
        </form>
        {msg && <p role="status" className={`mt-3 text-sm ${msg.kind === "ok" ? "text-success" : "text-destructive"}`}>{msg.text}</p>}
        <button onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }} className="mt-4 text-xs text-electric underline">
          {mode === "in" ? "Invited? Create your account" : "Already have an account? Sign in"}
        </button>
      </section>
    </div>
  );
}
