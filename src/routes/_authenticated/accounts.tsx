import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { getConnections, type Connector } from "@/lib/foundry.functions";

export const Route = createFileRoute("/_authenticated/accounts")({
  head: () => ({
    meta: [
      { title: "Connect Accounts — Jackboy" },
      { name: "description", content: "Every account Jackboy can use, with live status, permission scopes, where the credential is kept and how to revoke it." },
      { property: "og:title", content: "Connect Accounts — Jackboy" },
      { property: "og:description", content: "Live connection status, scopes and revocation for Jackboy's tools." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Accounts,
});

function Accounts() {
  const get = useServerFn(getConnections);
  const [c, setC] = useState<Connector[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { get().then(setC).catch((e) => setErr((e as Error).message)); }, [get]);
  const tone = (s: string) => (s === "connected" ? "text-success" : s === "error" ? "text-destructive" : "text-warning");
  return (
    <>
      <PageHeader title="Connect Accounts" subtitle="Checked live each time you open this page. Credentials stay in backend secrets and are never shown or stored in records." />
      {err && <p className="text-destructive">{err}</p>}
      {!c && !err && <p className="text-sm text-muted-foreground">Checking connections…</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {c?.map((x) => (
          <li key={x.id} className="panel p-4">
            <div className="flex items-center justify-between"><span className="font-medium">{x.name}</span><span className={`text-xs font-semibold uppercase ${tone(x.state)}`}>{x.state.replace("_", " ")}</span></div>
            <p className="text-xs text-muted-foreground">{x.kind}</p>
            <p className="mt-2 text-sm">{x.detail}</p>
            <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
              <div><dt className="inline font-semibold">Permissions: </dt><dd className="inline">{x.scopes}</dd></div>
              <div><dt className="inline font-semibold">Kept in: </dt><dd className="inline">{x.vault}</dd></div>
              <div><dt className="inline font-semibold">Revoke: </dt><dd className="inline">{x.revoke}</dd></div>
            </dl>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-xs text-muted-foreground">Sign-in to Jackboy itself stays invitation-only with email and password. Google sign-in is not enabled because Jackboy does not create new accounts.</p>
    </>
  );
}
