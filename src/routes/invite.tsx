import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { inspectInvite, redeemInvite } from "@/lib/account.functions";

export const Route = createFileRoute("/invite")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({ token: typeof s["token"] === "string" ? s["token"] : "" }),
  head: () => ({
    meta: [
      { title: "Accept invitation — Jackboy" },
      { name: "description", content: "Accept a private Jackboy invitation." },
      { property: "og:title", content: "Accept invitation — Jackboy" },
      { property: "og:description", content: "Invitation-only access to Jackboy." },
    ],
  }),
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useSearch();
  const inspect = useServerFn(inspectInvite);
  const redeem = useServerFn(redeemInvite);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof inspectInvite>> | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void inspect({ data: { token } }).then(setInfo); }, [token]);

  return (
    <section className="panel mx-auto mt-10 max-w-md p-6">
      <h1 className="text-xl font-semibold text-silver">Accept invitation</h1>
      {!info ? <p className="mt-3 text-sm text-muted-foreground">Checking link…</p> : !info.ok ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{info.reason}</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">This single-use invitation is for <strong>{info.email}</strong> as <strong>{info.role}</strong>. We'll email that address a verification link to set your password.</p>
          {!msg?.ok && <button disabled={busy} onClick={async () => { setBusy(true); try { setMsg({ ok: true, t: (await redeem({ data: { token } })).message }); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }} className="mt-4 w-full rounded-md bg-primary py-2 text-sm text-primary-foreground disabled:opacity-50">{busy ? "Sending…" : "Accept and verify email"}</button>}
        </>
      )}
      {msg && <p role="status" className={`mt-3 text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</p>}
    </section>
  );
}
