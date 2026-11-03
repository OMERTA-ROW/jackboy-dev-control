import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/AppShell";
import { passwordProblem } from "@/lib/account-auth";

export const Route = createFileRoute("/_authenticated/security")({
  head: () => ({
    meta: [
      { title: "Security — Jackboy" },
      { name: "description", content: "Manage your password, authenticator app codes and passkeys for Jackboy." },
      { property: "og:title", content: "Security — Jackboy" },
      { property: "og:description", content: "Two-step verification and password settings." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SecurityPage,
});

type Factor = { id: string; friendly_name?: string; status: string; created_at: string };
const input = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function SecurityPage() {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [cur, setCur] = useState(""); const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) return setMsg({ ok: false, t: error.message });
    setFactors(data.totp as Factor[]);
  }
  useEffect(() => { void load(); }, []);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setMsg(null);
    try { const t = await fn(); if (t) setMsg({ ok: true, t }); await load(); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }

  const startEnroll = () => run(async () => {
    // Remove abandoned unverified factors so enrollment can restart cleanly.
    for (const f of factors.filter((x) => x.status !== "verified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    if (error) throw new Error(/disabled|not enabled/i.test(error.message) ? "Authenticator codes are not enabled for this app's sign-in service." : error.message);
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  });
  const verifyEnroll = () => run(async () => {
    if (!enroll) return;
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.id, code: code.trim() });
    if (error) throw new Error("That code didn't match. Check your phone's clock and enter the current code.");
    setEnroll(null); setCode("");
    return "Authenticator added. You'll be asked for a code each time you sign in.";
  });
  const remove = (id: string) => run(async () => {
    if (!confirm("Remove this authenticator? Sign-in will no longer ask for its code.")) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
    if (error) throw new Error(/aal2/i.test(error.message) ? "Sign out and back in with your code, then try again." : error.message);
    return "Authenticator removed.";
  });
  const changePw = () => run(async () => {
    const p = passwordProblem(pw, pw2); if (p) throw new Error(p);
    const { error } = await supabase.auth.updateUser({ password: pw, current_password: cur } as never);
    if (error) throw new Error(error.message);
    setCur(""); setPw(""); setPw2("");
    return "Password changed.";
  });

  const verified = factors.filter((f) => f.status === "verified");
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Security" subtitle="Two-step sign-in codes, password and passkeys." />
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</p>}

      <section className="panel p-5">
        <h2 className="font-semibold text-silver">Authenticator app</h2>
        <p className="mt-1 text-xs text-muted-foreground">Works with Google Authenticator, 1Password, Authy and similar apps. Status: {verified.length ? <span className="text-success">On</span> : <span className="text-warning">Off</span>}</p>
        <ul className="mt-3 space-y-2">
          {verified.map((f) => (
            <li key={f.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <span>{f.friendly_name || "Authenticator"} <span className="text-xs text-muted-foreground">· added {new Date(f.created_at).toLocaleDateString()}</span></span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove(f.id)}>Remove</Button>
            </li>
          ))}
        </ul>
        {!enroll ? <Button className="mt-3" disabled={busy} onClick={() => void startEnroll()}>{verified.length ? "Add another authenticator" : "Set up authenticator"}</Button> : (
          <div className="mt-4 space-y-3">
            <p className="text-sm">Scan this code in your authenticator app, then enter the 6-digit code it shows.</p>
            <img src={enroll.qr} alt="Authenticator setup QR code" className="h-44 w-44 rounded bg-foreground p-2" />
            <p className="break-all text-xs text-muted-foreground">Can't scan? Enter this key manually: <code>{enroll.secret}</code></p>
            <label className="block text-sm">Code<input inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className={`${input} max-w-40 tracking-[0.4em]`} /></label>
            <div className="flex gap-2"><Button disabled={busy || code.length !== 6} onClick={() => void verifyEnroll()}>Verify and turn on</Button><Button variant="ghost" onClick={() => setEnroll(null)}>Cancel</Button></div>
          </div>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="font-semibold text-silver">Password</h2>
        <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); void changePw(); }}>
          <label className="block text-sm">Current password<input required type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} className={input} /></label>
          <label className="block text-sm">New password<input required minLength={10} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className={input} /></label>
          <label className="block text-sm">Confirm new password<input required type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={input} /></label>
          <Button disabled={busy}>Change password</Button>
        </form>
      </section>

      <section className="panel p-5">
        <h2 className="font-semibold text-silver">Passkeys</h2>
        <p className="mt-1 text-xs text-muted-foreground">Passkeys confirm sensitive actions (merges, reverts, permission changes). Manage registered devices in <Link to="/settings" className="text-electric underline">Settings</Link>.</p>
      </section>
    </div>
  );
}
