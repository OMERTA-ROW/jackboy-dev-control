import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({
    meta: [
      { title: "Account — Jackboy" },
      { name: "description", content: "Your Jackboy account, role and linked sign-in methods." },
      { property: "og:title", content: "Account — Jackboy" },
      { property: "og:description", content: "Account details and verified role." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AccountPage,
});

type Info = { email: string | null; confirmed: boolean; created: string; providers: string[]; role: string | null; aal: string | null };

function AccountPage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) return setErr("Could not verify your session.");
      // Role is read from the server (user_roles via my_role), never from client metadata.
      const { data: role } = await supabase.rpc("my_role");
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      setInfo({
        email: data.user.email ?? null,
        confirmed: Boolean(data.user.email_confirmed_at),
        created: data.user.created_at,
        providers: (data.user.identities ?? []).map((i) => i.provider),
        role: (role as string | null) ?? null,
        aal: aal?.currentLevel ?? null,
      });
    })();
  }, []);
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Account" subtitle="Who you're signed in as and what access the server grants you." />
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      {!info ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <dl className="panel grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 p-5 text-sm">
          <dt className="text-muted-foreground">Email</dt><dd>{info.email}</dd>
          <dt className="text-muted-foreground">Email verified</dt><dd className={info.confirmed ? "text-success" : "text-warning"}>{info.confirmed ? "Yes" : "No"}</dd>
          <dt className="text-muted-foreground">Role</dt><dd className="capitalize">{info.role ?? "No access granted"}</dd>
          <dt className="text-muted-foreground">Sign-in methods</dt><dd className="capitalize">{info.providers.join(", ") || "email"}</dd>
          <dt className="text-muted-foreground">This session</dt><dd>{info.aal === "aal2" ? "Verified with authenticator code" : "Password only"}</dd>
          <dt className="text-muted-foreground">Member since</dt><dd>{new Date(info.created).toLocaleDateString()}</dd>
        </dl>
      )}
      <p className="text-xs text-muted-foreground">Turn on authenticator codes under <Link to="/security" className="text-electric underline">Security</Link>.</p>
    </div>
  );
}
