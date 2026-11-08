import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Archive, ArchiveRestore, Download } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { DeviceRecordsImport, useOwnerRecords } from "@/components/OwnerRecords";
import { setJaxDraftArchived } from "@/lib/owner-records.functions";
import { canDistribute, potentialRevenue } from "@/lib/jax";

export const Route = createFileRoute("/_authenticated/jax")({
  head: () => ({
    meta: [
      { title: "JAX Releases — Jackboy" },
      { name: "description", content: "JAX draft release manifests saved to the owner's account; distribution needs JAX to be connected." },
      { property: "og:title", content: "JAX Releases — Jackboy" },
      { property: "og:description", content: "Owner-approved release planning for JAX." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Jax,
});

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

function Jax() {
  const { data, error, loading, refresh } = useOwnerRecords();
  const archive = useServerFn(setJaxDraftArchived);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const all = data?.manifests ?? [];
  const list = all.filter((m) => (showArchived ? m.archivedAt : !m.archivedAt));
  const archivedCount = all.filter((m) => m.archivedAt).length;

  return (
    <>
      <PageHeader title="JAX" subtitle="Commercialization and distribution of owner-approved releases." />
      <section className="panel mb-6 p-4 text-sm">
        <p className="font-medium">JAX is not connected. Nothing is sold or distributed from Jackboy, and there is no real revenue to show.</p>
        <p className="mt-1 text-muted-foreground">
          Draft manifests below are planning records saved to your account. They are always marked simulated and have no
          actual revenue. Make one from an approved handoff on the{" "}
          <Link to="/omni" className="text-electric underline">OMNI page</Link>.
        </p>
      </section>
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      <DeviceRecordsImport records={data} onImported={refresh} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{data ? `Read ${new Date(data.checkedAt).toLocaleTimeString()}` : loading ? "Reading…" : ""}</span>
        <div className="flex gap-3">
          {archivedCount > 0 && (
            <button onClick={() => setShowArchived((v) => !v)} className="text-electric underline">
              {showArchived ? "Show active" : `Show archived (${archivedCount})`}
            </button>
          )}
          <button onClick={() => void refresh()} disabled={loading} className="rounded-md border border-border px-2 py-1 disabled:opacity-50">
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </div>
      {msg && <p role={msg.tone === "error" ? "alert" : "status"} className={`mb-3 text-sm ${msg.tone === "error" ? "text-destructive" : "text-success"}`}>{msg.text}</p>}
      {data && list.length === 0 ? (
        <section className="panel p-6 text-sm text-muted-foreground">{showArchived ? "No archived drafts." : "No JAX draft manifests in your account yet."}</section>
      ) : (
        <ul className="space-y-3" aria-label="JAX draft manifests">
          {list.map((m) => {
            const rev = potentialRevenue(m.manifest);
            return (
              <li key={m.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-silver">{m.name} <span className="text-xs text-muted-foreground">v{m.version}</span></div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      <span className="rounded border border-warning/50 px-1.5 py-0.5 uppercase text-warning">Simulated</span>
                      {m.fromDevice && <span className="text-muted-foreground">imported from a browser</span>}
                      <span className="text-muted-foreground">saved {new Date(m.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const url = URL.createObjectURL(new Blob([JSON.stringify(m.manifest, null, 2)], { type: "application/json" }));
                        Object.assign(document.createElement("a"), { href: url, download: `jax-draft-${m.id.slice(0, 8)}.json` }).click();
                        URL.revokeObjectURL(url);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs"
                    >
                      <Download className="h-3.5 w-3.5" />JSON
                    </button>
                    <button
                      disabled={!!busy}
                      onClick={async () => {
                        setBusy(m.id);
                        setMsg(null);
                        try {
                          await archive({ data: { id: m.id, archived: !m.archivedAt } });
                          await refresh();
                          setMsg({ tone: "ok", text: m.archivedAt ? "Restored." : "Archived — kept in your account, not deleted." });
                        } catch (e) {
                          setMsg({ tone: "error", text: `Not saved: ${(e as Error).message}` });
                        } finally {
                          setBusy("");
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs disabled:opacity-50"
                    >
                      {m.archivedAt ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                      {busy === m.id ? "Saving…" : m.archivedAt ? "Restore" : "Archive"}
                    </button>
                  </div>
                </div>
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                  <div><dt className="text-muted-foreground">Projected gross (estimate)</dt><dd className="font-mono">{usd(rev.total)}/yr</dd></div>
                  <div><dt className="text-muted-foreground">Actual revenue</dt><dd>None — no payment integration connected</dd></div>
                  <div><dt className="text-muted-foreground">Distribution</dt><dd>{canDistribute(m.manifest) ? "Checklist cleared · not sent (JAX not connected)" : "Locked: provenance or data checks not cleared"}</dd></div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
