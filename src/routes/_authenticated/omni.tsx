import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, Trash2, ShieldAlert, CheckCircle2, XCircle } from "lucide-react";
import { GuidanceTip, PageHeader } from "@/components/AppShell";
import {
  canApprove,
  projectAnnual,
  removeHandoff,
  toMarkdown,
  updateHandoff,
  useHandoffs,
  type Handoff,
  type OwnerAction,
  type Revenue,
} from "@/lib/omni-handoff";
import { getOmniQueue, requestOmniJob } from "@/lib/passport.functions";
import { OmniLinkPanel } from "@/components/OmniLinkPanel";

export const Route = createFileRoute("/_authenticated/omni")({
  head: () => ({
    meta: [
      { title: "OMNI Handoffs — Jackboy" },
      {
        name: "description",
        content: "Approval queue, exportable briefs and monetization planning for ideas routed to OMNI.",
      },
      { property: "og:title", content: "OMNI Handoffs — Jackboy" },
      { property: "og:description", content: "Route vetted ideas to OMNI with owner approval." },
    ],
  }),
  component: OmniPage,
});

const STATUS_STYLE: Record<Handoff["status"], string> = {
  draft: "border-border text-muted-foreground",
  pending: "border-warning/50 text-warning",
  approved: "border-success/50 text-success",
  rejected: "border-destructive/50 text-destructive",
};
const num = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function OmniPage() {
  const handoffs = useHandoffs();
  const [selected, setSelected] = useState<string | null>(null);
  const current = handoffs.find((h) => h.id === selected) ?? handoffs[0];

  return (
    <>
      <PageHeader
        title="OMNI Handoffs"
        subtitle="Jackboy researches and evaluates. OMNI builds, tests and ships — only after you approve."
      />
      <OmniLinkPanel />
      <GuidanceTip>
        Approve a handoff, then clear the provenance checklist. Publishing, pricing and selling stay locked until both
        are done.
      </GuidanceTip>
      <InternalTaskQueue />

      {handoffs.length === 0 ? (
        <section className="panel p-6 text-sm text-muted-foreground">
          No research handoffs yet. Open{" "}
          <Link to="/discovery" className="text-electric underline">
            Discovery
          </Link>{" "}
          — handoffs appear here once a real discovery source produces findings.
        </section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <ul className="space-y-2" aria-label="Handoff queue">
            {handoffs.map((h) => (
              <li key={h.id}>
                <button
                  onClick={() => setSelected(h.id)}
                  aria-current={current?.id === h.id}
                  className={`panel w-full p-3 text-left ${current?.id === h.id ? "glow-electric" : ""}`}
                >
                  <div className="text-sm font-medium text-silver">{h.title}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    <span className={`rounded border px-1.5 py-0.5 uppercase ${STATUS_STYLE[h.status]}`}>
                      {h.status}
                    </span>
                    <span className="text-muted-foreground">
                      priority {h.priority} · risk {h.risk}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {current && <Detail h={current} />}
        </div>
      )}
    </>
  );
}

function InternalTaskQueue() {
  const load = useServerFn(getOmniQueue);
  const queue = useServerFn(requestOmniJob);
  const [data, setData] = useState<Awaited<ReturnType<typeof getOmniQueue>> | null>(null);
  const [projectId, setProjectId] = useState("");
  const [kind, setKind] = useState<"code" | "test">("code");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      setData(await load());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <section className="panel mb-6 p-4" aria-label="Internal OMNI tasks">
      <h2 className="text-lg font-semibold text-silver">Internal build tasks</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Record development work in Jackboy. OMNI has no verified dispatcher; queued tasks stay here until an
        authenticated connection is built and tested.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {data && (
        <form
          className="mt-4 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!projectId || !instructions.trim()) return;
            setBusy(true);
            setError("");
            try {
              await queue({ data: { projectId, kind, instructions } });
              setInstructions("");
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
            <select
              required
              aria-label="Task project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={num}
            >
              <option value="">Choose a registered project</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Task type"
              value={kind}
              onChange={(e) => setKind(e.target.value as "code" | "test")}
              className={num}
            >
              <option value="code">Build</option>
              <option value="test">Test</option>
            </select>
          </div>
          <textarea
            required
            minLength={3}
            maxLength={4000}
            aria-label="Task instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className={num}
            rows={4}
            placeholder="Describe the build, expected result, and evidence needed."
          />
          <button
            disabled={busy || !data.projects.length}
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Saving…" : "Queue internal task"}
          </button>
          {!data.projects.length && <p className="text-xs text-warning">Add the OMNI project in Agent Hub first.</p>}
        </form>
      )}
      <ul className="mt-4 space-y-2 text-sm" aria-label="Recorded OMNI jobs">
        {data?.jobs.map((j) => (
          <li key={j.id} className="rounded-md border border-border p-3">
            <span className="font-semibold">
              {data.projects.find((p) => p.id === j.project_id)?.name ?? "Project"} · {j.kind}
            </span>
            <p className="mt-1 whitespace-pre-wrap text-xs">{j.instructions}</p>
            <p className="mt-1 text-xs text-warning">
              {j.sent_at ? j.status : "Queued here — not sent to OMNI"} · Guardian {j.guardian_verdict}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Detail({ h }: { h: Handoff }) {
  const { streams, total } = projectAnnual(h.revenue);
  const setRev = <K extends keyof Revenue>(k: K, key: keyof Revenue[K], v: number) =>
    updateHandoff(h.id, (x) => ({
      ...x,
      revenue: { ...x.revenue, [k]: { ...x.revenue[k], [key]: Math.max(0, v || 0) } },
    }));
  const prov = (k: "ownershipConfirmed" | "ossReviewed" | "noScrapedOrUnlicensed", v: boolean) =>
    updateHandoff(
      h.id,
      (x) => ({ ...x, provenance: { ...x.provenance, [k]: v } }),
      `${k} set to ${v} on "${h.title}"`,
      "approval",
    );
  const decide = (status: Handoff["status"]) =>
    updateHandoff(
      h.id,
      (x) => ({
        ...x,
        status,
        approvals: status === "approved" ? x.approvals : { publish: false, pricing: false, deploy: false, sell: false },
      }),
      `${status} "${h.title}"`,
      "approval",
    );
  const approveAction = (a: OwnerAction, v: boolean) =>
    updateHandoff(
      h.id,
      (x) => ({ ...x, approvals: { ...x.approvals, [a]: v } }),
      `${v ? "approved" : "revoked"} ${a} for "${h.title}"`,
      "approval",
    );

  const STREAMS: { k: keyof Revenue; label: string; fields: [string, string][] }[] = [
    {
      k: "saas",
      label: "SaaS subscriptions",
      fields: [
        ["price", "$/month"],
        ["subscribers", "subscribers"],
      ],
    },
    {
      k: "licensing",
      label: "Commercial licensing",
      fields: [
        ["price", "$/license/yr"],
        ["deals", "licenses"],
      ],
    },
    {
      k: "api",
      label: "API metering",
      fields: [
        ["pricePer1k", "$/1k calls"],
        ["callsPerMonth", "calls/month"],
      ],
    },
    {
      k: "marketplace",
      label: "Code/template marketplace",
      fields: [
        ["price", "$/item"],
        ["salesPerMonth", "sales/month"],
      ],
    },
    {
      k: "services",
      label: "Custom development & support",
      fields: [
        ["rate", "$/hour"],
        ["hoursPerMonth", "hours/month"],
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-lg font-semibold text-silver">{h.title}</h2>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => download(`omni-brief-${h.id.slice(0, 8)}.md`, toMarkdown(h), "text/markdown")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs"
            >
              <Download className="h-3.5 w-3.5" />
              Markdown
            </button>
            <button
              onClick={() =>
                download(`omni-brief-${h.id.slice(0, 8)}.json`, JSON.stringify(h, null, 2), "application/json")
              }
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs"
            >
              <Download className="h-3.5 w-3.5" />
              JSON
            </button>
            <button
              aria-label="Delete handoff"
              onClick={() => removeHandoff(h.id)}
              className="rounded-md border border-destructive/40 px-2 py-1.5 text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">Sources</dt>
            <dd className="break-all font-mono text-xs">{h.sources.join(", ")}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">Feasibility · Est. cost</dt>
            <dd>
              {h.feasibility}/5 · {usd(h.estCost)} <span className="text-xs text-muted-foreground">(estimate)</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-electric">Hypothesis (AI, unverified)</dt>
            <dd>{h.hypothesis}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-warning">Novelty caveat</dt>
            <dd>{h.noveltyCaveat}</dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">Requirements</dt>
            <dd className="whitespace-pre-wrap font-mono text-xs">{h.requirements}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => decide("approved")}
            disabled={h.status === "approved"}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Approve handoff
          </button>
          <button
            onClick={() => decide("rejected")}
            disabled={h.status === "rejected"}
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive disabled:opacity-50"
          >
            <XCircle className="h-3.5 w-3.5" />
            Reject
          </button>
          <button
            onClick={() => decide("pending")}
            disabled={h.status === "pending"}
            className="rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50"
          >
            Back to pending
          </button>
        </div>
      </section>

      <section className="panel p-4" aria-labelledby="mon">
        <h3 id="mon" className="text-sm font-semibold uppercase tracking-wider text-silver">
          Monetization plan
        </h3>
        <p className="mt-1 text-xs text-warning">
          Proposed pricing and projected gross revenue are estimates you enter — not actual earnings, quotes or
          guarantees.
        </p>
        <div className="mt-3 space-y-3">
          {STREAMS.map(({ k, label, fields }) => (
            <div key={k} className="grid items-end gap-2 sm:grid-cols-[1fr_120px_120px_120px]">
              <div className="text-sm">{label}</div>
              {fields.map(([key, hint]) => (
                <label key={key} className="text-[11px] text-muted-foreground">
                  {hint}
                  <input
                    type="number"
                    min={0}
                    value={(h.revenue[k] as Record<string, number>)[key]}
                    onChange={(e) => setRev(k, key as never, Number(e.target.value))}
                    className={num}
                  />
                </label>
              ))}
              <div className="text-right font-mono text-sm text-silver">{usd(streams[k])}/yr</div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-between border-t border-border pt-3 text-sm">
          <span>Projected gross (estimate)</span>
          <span className="font-display text-lg text-electric">{usd(total)}/yr</span>
        </div>
      </section>

      <section className="panel p-4" aria-labelledby="prov">
        <h3 id="prov" className="text-sm font-semibold uppercase tracking-wider text-silver">
          Ownership & license provenance
        </h3>
        <div className="mt-3 space-y-2 text-sm">
          {(
            [
              ["ownershipConfirmed", "I own or have rights to all original code, designs and assets."],
              [
                "ossReviewed",
                "Third-party open-source licenses reviewed; attribution, copyleft and notice obligations will be met.",
              ],
              [
                "noScrapedOrUnlicensed",
                "Contains no scraped code, copyrighted material or unlicensed assets for resale.",
              ],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={h.provenance[k]}
                onChange={(e) => prov(k, e.target.checked)}
                className="mt-1 accent-[var(--electric)]"
              />
              <span>{label}</span>
            </label>
          ))}
          <textarea
            placeholder="Provenance notes (licenses, dependencies, attributions)…"
            value={h.provenance.notes}
            onChange={(e) =>
              updateHandoff(h.id, (x) => ({ ...x, provenance: { ...x.provenance, notes: e.target.value } }))
            }
            className="mt-2 w-full rounded-md border border-input bg-background p-2 text-sm"
            rows={2}
          />
          <p className="text-xs text-muted-foreground">
            Self-attestation only. Jackboy does not scan licenses yet; get legal review before commercial use.
          </p>
        </div>
      </section>

      <section className="panel p-4" aria-labelledby="own">
        <h3 id="own" className="text-sm font-semibold uppercase tracking-wider text-silver">
          Owner approvals
        </h3>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {(["publish", "pricing", "deploy", "sell"] as OwnerAction[]).map((a) => {
            const allowed = canApprove(h, a);
            return (
              <li key={a} className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
                <span className="capitalize">{a}</span>
                <label className={`flex items-center gap-2 text-xs ${allowed ? "" : "text-muted-foreground"}`}>
                  <input
                    type="checkbox"
                    disabled={!allowed}
                    checked={h.approvals[a] && allowed}
                    onChange={(e) => approveAction(a, e.target.checked)}
                  />
                  {allowed ? (h.approvals[a] ? "Approved" : "Approve") : "Locked"}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Approval records your decision only. Nothing is published, priced, deployed or sold until OMNI and payment
          integrations are connected and verified.
        </p>
      </section>
    </div>
  );
}
