import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Download, Ban, ShieldAlert, Trash2, Rocket, FileJson } from "lucide-react";
import { toast } from "sonner";
import { GuidanceTip, PageHeader } from "@/components/AppShell";
import { useHandoffs } from "@/lib/omni-handoff";
import {
  INTEGRATION_CONTRACT, PROHIBITED, addManifest, canDistribute, dataProductCleared, manifestFromHandoff,
  potentialRevenue, removeManifest, updateManifest, useManifests, type DataGovernance, type ReleaseManifest,
} from "@/lib/jax";

export const Route = createFileRoute("/jax")({
  head: () => ({
    meta: [
      { title: "JAX Release Hub — Jackboy" },
      { name: "description", content: "Auditable release manifests and estimated revenue handoff from OMNI to JAX." },
      { property: "og:title", content: "JAX Release Hub — Jackboy" },
      { property: "og:description", content: "Release-to-JAX manifests with governance and owner approval." },
    ],
  }),
  component: JaxPage,
});

const inp = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}
const Sim = () => <span className="rounded border border-warning/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warning">Simulated</span>;

function JaxPage() {
  const handoffs = useHandoffs().filter((h) => h.status === "approved");
  const manifests = useManifests();
  const [hid, setHid] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [owner, setOwner] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const current = manifests.find((m) => m.id === sel) ?? manifests[0];

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const h = handoffs.find((x) => x.id === (hid || handoffs[0]?.id));
    if (!h) return;
    const m = manifestFromHandoff(h, version.trim(), owner.trim());
    addManifest(m); setSel(m.id); toast("Simulated release manifest created.");
  };

  return (
    <>
      <PageHeader title="JAX Release Hub" subtitle="Jackboy discovers → OMNI builds and releases → JAX tracks commercialization and permitted distribution." />
      <div className="mb-4 flex gap-2 rounded-md border border-warning/40 bg-muted p-3 text-sm">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span><strong className="text-warning">OMNI and JAX are not connected.</strong> Releases here are simulated and exported as manifests. Actual revenue is shown only from verified payments — none are connected.</span>
      </div>
      <GuidanceTip>Create a simulated release from an approved OMNI handoff, complete governance, then approve distribution. Export the manifest for JAX.</GuidanceTip>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <form onSubmit={create} className="panel p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-silver"><Rocket className="h-4 w-4" />New simulated release</h2>
          {handoffs.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No approved handoffs. Approve one on the <Link to="/omni" className="text-electric underline">OMNI</Link> page first.</p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <label className="text-xs text-muted-foreground sm:col-span-3">Approved handoff
                <select value={hid} onChange={(e) => setHid(e.target.value)} className={inp}>{handoffs.map((h) => <option key={h.id} value={h.id}>{h.title}</option>)}</select>
              </label>
              <label className="text-xs text-muted-foreground">Version<input required pattern="\d+\.\d+\.\d+" value={version} onChange={(e) => setVersion(e.target.value)} className={inp} /></label>
              <label className="text-xs text-muted-foreground sm:col-span-2">Owner<input required value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner name" className={inp} /></label>
              <button className="rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground sm:col-span-3">Create manifest</button>
            </div>
          )}
        </form>
        <section className="panel p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-destructive"><Ban className="h-4 w-4" />Never sold or transferred automatically</h2>
          <ul className="mt-3 flex flex-wrap gap-2">{PROHIBITED.map((p) => <li key={p} className="rounded border border-destructive/40 px-2 py-1 text-xs">{p}</li>)}</ul>
          <button onClick={() => download("jax-integration-contract.json", INTEGRATION_CONTRACT)} className="mt-4 inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs"><FileJson className="h-3.5 w-3.5" />Export integration contract</button>
        </section>
      </div>

      {manifests.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <ul className="space-y-2" aria-label="Release manifests">
            {manifests.map((m) => (
              <li key={m.id}><button onClick={() => setSel(m.id)} aria-current={current?.id === m.id} className={`panel w-full p-3 text-left ${current?.id === m.id ? "glow-electric" : ""}`}>
                <div className="text-sm font-medium text-silver">{m.name}</div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><Sim />v{m.version} · {m.distribution.approved ? <span className="text-success">distribution approved</span> : "not distributed"}</div>
              </button></li>
            ))}
          </ul>
          {current && <ManifestDetail m={current} />}
        </div>
      )}
    </>
  );
}

function ManifestDetail({ m }: { m: ReleaseManifest }) {
  const rev = potentialRevenue(m);
  const g = m.dataProduct.governance;
  const setGov = (patch: Partial<DataGovernance>, ev?: string) =>
    updateManifest(m.id, (x) => ({ ...x, dataProduct: { ...x.dataProduct, governance: { ...x.dataProduct.governance, ...patch } }, distribution: { approved: false, approvedAt: null } }), ev);
  const distributable = canDistribute(m);
  const checks: [keyof DataGovernance, string][] = [
    ["optIn", "Collection is opt-in"], ["consentRecorded", "Consent recorded"], ["aggregated", "Aggregated / de-identified"],
    ["deletionSupported", "Deletion on request supported"], ["legalReviewed", "Applicable law & contracts reviewed"],
  ];

  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h2 className="text-lg font-semibold text-silver">{m.name} <span className="font-mono text-sm text-muted-foreground">v{m.version}</span></h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Sim />{m.projectId} · owner {m.owner} · {m.contract}</div></div>
          <div className="flex gap-2">
            <button onClick={() => download(`jax-manifest-${m.projectId}-v${m.version}.json`, m)} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs"><Download className="h-3.5 w-3.5" />Export manifest</button>
            <button aria-label="Delete manifest" onClick={() => removeManifest(m.id)} className="rounded-md border border-destructive/40 px-2 text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        </div>
        <dl className="mt-3 grid gap-3 text-sm md:grid-cols-2">
          <div><dt className="text-xs uppercase tracking-wider text-muted-foreground">Provenance</dt><dd className="text-xs">
            {[["Ownership", m.provenance.ownershipConfirmed], ["OSS reviewed", m.provenance.ossReviewed], ["No scraped/unlicensed", m.provenance.noScrapedOrUnlicensed]].map(([l, v]) => (
              <div key={l as string} className={v ? "text-success" : "text-destructive"}>{v ? "✓" : "✗"} {l}</div>))}
            {m.provenance.licenses && <div className="mt-1 text-muted-foreground">{m.provenance.licenses}</div>}</dd></div>
          <div><dt className="text-xs uppercase tracking-wider text-muted-foreground">Feature inventory</dt><dd><ul className="list-disc pl-4 text-xs">{m.features.map((f) => <li key={f}>{f}</li>)}</ul></dd></div>
          <div><dt className="text-xs uppercase tracking-wider text-muted-foreground">Pricing & entitlements (proposed)</dt><dd className="text-xs">{m.pricing.tiers.length ? m.pricing.tiers.map((t) => `${t.name}: ${usd(t.pricePerMonth)}/mo — ${t.entitlements}`).join("; ") : "None set"}</dd></div>
          <div><dt className="text-xs uppercase tracking-wider text-muted-foreground">API usage</dt><dd className="text-xs">{m.apiUsage.callsPerMonth.toLocaleString()} calls/month <span className="text-warning">(estimate, not metered)</span></dd></div>
        </dl>
      </section>

      <section className="panel p-4" aria-labelledby="rev">
        <h3 id="rev" className="text-sm font-semibold uppercase tracking-wider text-silver">JAX revenue view</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md bg-muted p-3">
            <div className="text-xs uppercase tracking-wider text-warning">Potential (estimate)</div>
            <div className="font-display text-2xl text-electric">{usd(rev.total)}<span className="text-sm">/yr</span></div>
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {Object.entries(m.monetization).map(([k, v]) => <li key={k} className="flex justify-between"><span className="capitalize">{k}</span><span>{usd(v)}</span></li>)}
              <li className="flex justify-between"><span>Licensed data product</span><span>{usd(rev.dataProduct)}</span></li>
            </ul>
          </div>
          <div className="rounded-md bg-muted p-3">
            <div className="text-xs uppercase tracking-wider text-success">Actual (verified payments)</div>
            <div className="font-display text-2xl text-muted-foreground">—</div>
            <p className="mt-2 text-xs text-muted-foreground">No payment integration connected. Actual revenue is never estimated or simulated.</p>
          </div>
        </div>
      </section>

      <section className="panel p-4" aria-labelledby="gov">
        <div className="flex items-center justify-between gap-2">
          <h3 id="gov" className="text-sm font-semibold uppercase tracking-wider text-silver">Authorized data product & governance</h3>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={m.dataProduct.enabled}
            onChange={(e) => updateManifest(m.id, (x) => ({ ...x, dataProduct: { ...x.dataProduct, enabled: e.target.checked }, distribution: { approved: false, approvedAt: null } }), `data product ${e.target.checked ? "enabled" : "disabled"} for ${m.name}`)} />Offer licensed data product</label>
        </div>
        {m.dataProduct.enabled ? (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-muted-foreground md:col-span-2">Purpose (what the data is for, specifically)<input value={g.purpose} onChange={(e) => setGov({ purpose: e.target.value })} className={inp} /></label>
            <label className="text-xs text-muted-foreground md:col-span-2">Permitted outputs (comma-separated, aggregated only)
              <input value={m.permittedDataOutputs.join(", ")} onChange={(e) => updateManifest(m.id, (x) => ({ ...x, permittedDataOutputs: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))} className={inp} /></label>
            <label className="text-xs text-muted-foreground">Access policy<input value={g.accessPolicy} onChange={(e) => setGov({ accessPolicy: e.target.value })} placeholder="Who may access, under which license" className={inp} /></label>
            <label className="text-xs text-muted-foreground">Retention (days, max 365)<input type="number" min={1} max={365} value={g.retentionDays} onChange={(e) => setGov({ retentionDays: Number(e.target.value) })} className={inp} /></label>
            <label className="text-xs text-muted-foreground">Price per licensee/yr (estimate)<input type="number" min={0} value={m.dataProduct.pricePerYear} onChange={(e) => updateManifest(m.id, (x) => ({ ...x, dataProduct: { ...x.dataProduct, pricePerYear: Math.max(0, Number(e.target.value)) } }))} className={inp} /></label>
            <label className="text-xs text-muted-foreground">Expected licensees<input type="number" min={0} value={m.dataProduct.licensees} onChange={(e) => updateManifest(m.id, (x) => ({ ...x, dataProduct: { ...x.dataProduct, licensees: Math.max(0, Number(e.target.value)) } }))} className={inp} /></label>
            <div className="space-y-1.5 md:col-span-2">
              {checks.map(([k, l]) => (
                <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={g[k] as boolean} onChange={(e) => setGov({ [k]: e.target.checked }, `${l}: ${e.target.checked} (${m.name})`)} />{l}</label>
              ))}
            </div>
            <p className={`text-xs md:col-span-2 ${dataProductCleared(g) ? "text-success" : "text-warning"}`}>
              {dataProductCleared(g) ? "Governance cleared — data product can count toward potential revenue." : "Governance incomplete — data product excluded from revenue and distribution."}
            </p>
          </div>
        ) : <p className="mt-2 text-xs text-muted-foreground">No data product. Nothing beyond the released product is distributed.</p>}
      </section>

      <section className="panel p-4" aria-labelledby="dist">
        <h3 id="dist" className="text-sm font-semibold uppercase tracking-wider text-silver">Owner distribution approval</h3>
        <label className={`mt-3 flex items-center gap-2 text-sm ${distributable ? "" : "text-muted-foreground"}`}>
          <input type="checkbox" disabled={!distributable} checked={m.distribution.approved}
            onChange={(e) => updateManifest(m.id, (x) => ({ ...x, distribution: { approved: e.target.checked, approvedAt: e.target.checked ? new Date().toISOString() : null } }), `distribution ${e.target.checked ? "approved" : "revoked"} for ${m.name} v${m.version}`)} />
          {distributable ? "I approve permitted distribution via JAX" : "Locked — complete provenance (on OMNI page) and data governance first"}
        </label>
        <p className="mt-1 text-xs text-muted-foreground">Recorded in the audit trail only. Nothing is transmitted until JAX is connected and verified.</p>
        <h4 className="mt-4 text-xs uppercase tracking-wider text-muted-foreground">Audit trail</h4>
        <ol className="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-xs">
          {[...m.audit].reverse().map((a, i) => <li key={i} className="flex gap-2"><time className="shrink-0 text-muted-foreground">{new Date(a.at).toLocaleString()}</time><span>{a.event}</span></li>)}
        </ol>
      </section>
    </div>
  );
}
