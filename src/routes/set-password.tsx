import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { recordRecoveryEvent } from "@/lib/recovery.functions";
import { passwordProblem } from "@/lib/account-auth";

export const Route = createFileRoute("/set-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Set password — Jackboy" },
      { name: "description", content: "Set or reset your Jackboy password after verifying your email." },
      { property: "og:title", content: "Set password — Jackboy" },
      { property: "og:description", content: "Verified password setup for Jackboy." },
    ],
  }),
  component: SetPassword,
});

function SetPassword() {
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const recordFn = useServerFn(recordRecoveryEvent);
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_e, s) => { if (s) setReady(true); });
    void supabase.auth.getSession().then(({ data: d }) => { if (d.session) setReady(true); });
    return () => data.subscription.unsubscribe();
  }, []);
  return (
    <section className="panel mx-auto mt-10 max-w-sm p-6">
      <h1 className="text-xl font-semibold text-silver">Set your password</h1>
      {!ready ? <p className="mt-3 text-sm text-muted-foreground">Open this page from the verification or recovery email link.</p> : (
        <form className="mt-4 space-y-3" onSubmit={async (e) => { e.preventDefault(); const p = passwordProblem(pw); if (p) return setMsg(p); const { error } = await supabase.auth.updateUser({ password: pw }); if (error) return setMsg(/expired|invalid/i.test(error.message) ? "This link has expired or was already used. Request a new reset link." : error.message); await recordFn({ data: { kind: "password_reset" } }).catch(() => undefined); nav({ to: "/onboarding" }); }}>
          <label className="block text-sm">New password<input required minLength={10} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" /></label>
          <button className="w-full rounded-md bg-primary py-2 text-sm text-primary-foreground">Save password</button>
        </form>
      )}
      {msg && <p role="alert" className="mt-3 text-sm text-destructive">{msg}</p>}
    </section>
  );
}
