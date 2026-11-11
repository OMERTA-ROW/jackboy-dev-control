import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { PlugZap, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { mfaChallengeRequired } from "@/lib/account-auth";

type Decision = { data: { redirect_url?: string; redirect_to?: string } | null; error: { message: string } | null };
type Details = {
  client?: { name?: string; client_name?: string; uri?: string; client_uri?: string } | null;
  redirect_uri?: string;
  scope?: string;
  redirect_url?: string;
  redirect_to?: string;
};

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  email: "Share your email address",
  profile: "Share your basic profile",
};

const CAPABILITIES = [
  "See which account is connected and its Jackboy role",
  "Read the Kill Switch, Guardian and limit settings",
  "List projects, OMNI jobs and tasks",
  "Read the activity log and approval requests (owner only)",
];

export const Route = createFileRoute("/.lovable/oauth/consent")({
  // The session lives in browser storage; SSR would treat everyone as signed out.
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s["authorization_id"] === "string" ? s["authorization_id"] : "",
  }),
  head: () => ({
    meta: [
      { title: "Connect an assistant — Jackboy" },
      { name: "description", content: "Approve or cancel an AI assistant's read-only connection to your Jackboy account." },
      { property: "og:title", content: "Connect an assistant — Jackboy" },
      { property: "og:description", content: "Owner-controlled approval for assistant connections to Jackboy." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("This connection link is missing its request ID. Start the connection again from your assistant.");
    const next = location.pathname + location.searchStr;
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/auth", search: { next } });
    // Accounts with two-step verification must finish it before approving anything.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (mfaChallengeRequired(aal)) throw redirect({ to: "/auth", search: { next } });
  },
  loaderDeps: ({ search }) => ({ id: search.authorization_id }),
  loader: async ({ deps }) => {
    const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(deps.id);
    if (error) throw new Error(/not found|expired|invalid/i.test(error.message) ? "This connection request has expired or is no longer valid. Start again from your assistant." : error.message);
    const details = (data ?? {}) as Details;
    const immediate = details.redirect_url ?? details.redirect_to;
    if (immediate && !details.client) throw redirect({ href: immediate });
    const [{ data: user }, { data: role }] = await Promise.all([supabase.auth.getUser(), supabase.rpc("my_role")]);
    return { details, email: user.user?.email ?? null, role: typeof role === "string" ? role : null };
  },
  component: Consent,
  pendingComponent: () => <section className="panel mx-auto mt-10 max-w-md p-6 text-sm text-muted-foreground">Loading connection request…</section>,
  errorComponent: ({ error }) => (
    <section className="panel mx-auto mt-10 max-w-md p-6" role="alert">
      <h1 className="text-lg font-semibold text-silver">Could not load this connection request</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
    </section>
  ),
});

function hostOf(uri?: string): string | null {
  if (!uri) return null;
  try { return new URL(uri).host; } catch { return uri; }
}

function Consent() {
  const { details, email, role } = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = details.client?.name ?? details.client?.client_name ?? "An assistant";
  const scopes = (details.scope ?? "").split(/\s+/).filter(Boolean);
  const redirectHost = hostOf(details.redirect_uri);

  async function decide(approve: boolean) {
    setBusy(approve ? "approve" : "deny"); setError(null);
    try {
      const { data, error: e } = (approve
        ? await supabase.auth.oauth.approveAuthorization(authorization_id)
        : await supabase.auth.oauth.denyAuthorization(authorization_id)) as Decision;
      if (e) throw new Error(e.message);
      const target = data?.redirect_url ?? data?.redirect_to;
      if (!target) throw new Error("The sign-in service did not say where to go next. Start again from your assistant.");
      window.location.href = target;
    } catch (err) {
      setError(`${approve ? "Approval" : "Cancelling"} failed: ${(err as Error).message}`);
      setBusy(null);
    }
  }

  return (
    <section className="panel mx-auto mt-10 max-w-md p-6" aria-labelledby="consent-h">
      <h1 id="consent-h" className="flex items-center gap-2 text-xl font-semibold text-silver">
        <PlugZap className="h-5 w-5 text-electric" />Connect {client} to Jackboy
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">This lets {client} use Jackboy as you, with read-only tools.</p>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Signed in as</dt><dd className="truncate text-silver">{email ?? "Unknown account"}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Your role</dt><dd className="text-silver">{role ?? "No access yet"}</dd></div>
        {redirectHost && <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Returns to</dt><dd className="truncate font-mono text-xs text-silver">{redirectHost}</dd></div>}
      </dl>

      <div className="mt-4">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">What it can do</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {CAPABILITIES.map((c) => <li key={c}>{c}</li>)}
          {scopes.map((s) => <li key={s}>{SCOPE_LABELS[s] ?? `Additional permission requested: ${s}`}</li>)}
        </ul>
        <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          It cannot approve, send jobs, change settings or turn on automation. Your Jackboy role still decides what it can see.
        </p>
      </div>

      {!role && <p role="status" className="mt-4 text-sm text-warning">This account has no Jackboy access yet, so the assistant would see nothing. Ask the owner for an invitation first.</p>}
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}

      <div className="mt-5 flex gap-2">
        <Button className="flex-1" disabled={busy !== null || !role} onClick={() => void decide(true)}>{busy === "approve" ? "Approving…" : "Approve"}</Button>
        <Button variant="outline" className="flex-1" disabled={busy !== null} onClick={() => void decide(false)}>{busy === "deny" ? "Cancelling…" : "Cancel connection"}</Button>
      </div>
    </section>
  );
}
