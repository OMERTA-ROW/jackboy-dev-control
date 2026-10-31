import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Bookmark, BookmarkCheck, ExternalLink, FlaskConical, Bell, Trash2, Hexagon } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GuidanceTip, PageHeader } from "@/components/AppShell";
import { SendToOmni } from "@/components/SendToOmni";
import { CREATOR_LABEL, DEMO_FINDINGS, SOURCES, dedupe, frontierScore, gemReasons, meta, mixTracks, rankScore, setDiscovery, useDiscovery, type Finding, type Maturity } from "@/lib/discovery";
import { Gem, Scale } from "lucide-react";

export const Route = createFileRoute("/discovery")({
  head: () => ({
    meta: [
      { title: "Technology Discovery — Jackboy" },
      { name: "description", content: "Opt-in research scanner for emerging technologies and invention opportunities." },
      { property: "og:title", content: "Technology Discovery — Jackboy" },
      { property: "og:description", content: "Discover, cite and rank emerging technology opportunities." },
    ],
  }),
  component: Discovery,
});

const MATURITY: Maturity[] = ["research", "prototype", "pilot", "commercial"];
const input = "rounded-md border border-input bg-background px-3 py-2 text-sm";

function Tag({ kind, children }: { kind: "fact" | "ai"; children: React.ReactNode }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${kind === "fact" ? "border-success/50 text-success" : "border-electric/50 text-electric"}`}>{children}</span>
  );
}

function brief(f: Finding) {
  return `PROTOTYPE BRIEF (AI hypothesis — demo, not reviewed)
Idea: ${f.idea}
Based on: ${f.title} — ${f.url}
Problem / gap: ${f.gap}
Existing work (unverified): ${f.priorArt}
First prototype: smallest test proving the core claim in 2–4 weeks.
Risks: evidence maturity "${f.maturity}", confidence ${f.scores.confidence}/5.
Novelty: NOT established. A professional patent search and review is required before any novelty claim.`;
}

function Discovery() {
  const s = useDiscovery();
  const [q, setQ] = useState("");
  const [sector, setSector] = useState("all");
  const [maturity, setMaturity] = useState("all");
  const [track, setTrack] = useState("all");
  const [open, setOpen] = useState<Finding | null>(null);
  const [alertSector, setAlertSector] = useState("all");
  const [alertMin, setAlertMin] = useState(60);

  const findings = useMemo(() => {
    const active = dedupe(DEMO_FINDINGS).filter((f) => s.sources[f.sourceId]);
    const filtered = active
      .filter((f) => (sector === "all" || f.sector === sector) && (maturity === "all" || f.maturity === maturity))
      .filter((f) => track === "all" || meta(f).track === track)
      .filter((f) => !s.gemsOnly || gemReasons(f).length > 0)
      .filter((f) => !q || `${f.title} ${f.evidence} ${f.idea}`.toLowerCase().includes(q.toLowerCase()));
    const com = filtered.filter((f) => meta(f).track === "commercial").sort((a, b) => rankScore(b.scores) - rankScore(a.scores));
    const fro = filtered.filter((f) => meta(f).track === "frontier").sort((a, b) => frontierScore(b) - frontierScore(a));
    return mixTracks(com, fro, s.frontierShare);
  }, [s.sources, q, sector, maturity, track, s.gemsOnly, s.frontierShare]);
  const sectors = [...new Set(DEMO_FINDINGS.map((f) => f.sector))];
  const alertHits = (sec: string, min: number) => findings.filter((f) => (sec === "all" || f.sector === sec) && rankScore(f.scores) >= min).length;

  if (!s.optIn) {
    return (
      <>
        <PageHeader title="Technology Discovery" subtitle="An opt-in scanner for emerging technologies and invention ideas from lawful public sources." />
        <section className="panel max-w-2xl p-6">
          <Hexagon className="h-8 w-8 text-electric" aria-hidden />
          <h2 className="mt-3 text-lg font-semibold text-silver">Off until you turn it on</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Uses public APIs and RSS feeds only; obeys robots.txt, rate limits, licenses and terms.</li>
            <li>Never logs in on your behalf or reads private or paywalled content.</li>
            <li>Every item cites its original link. Facts and AI hypotheses are labeled separately.</li>
            <li>Currently shows <strong className="text-warning">demo data</strong> — live scanning needs a backend (see Sources tab).</li>
          </ul>
          <button className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" onClick={() => setDiscovery((x) => ({ ...x, optIn: true }), "opted in")}>Enable Technology Discovery</button>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Technology Discovery" subtitle="Ranked opportunities from public research, patents, standards, open source and news." />
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-muted p-3 text-sm">
        <span className="text-warning">Demo data — no live sources connected.</span>
        <span className="text-muted-foreground">Last scan: {s.lastScan ? new Date(s.lastScan).toLocaleString() : "never"}</span>
        <button className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs" onClick={() => { setDiscovery((x) => ({ ...x, lastScan: new Date().toISOString() }), "demo scan run (sample data reloaded, no network calls)"); toast("Demo scan complete — sample data only."); }}>Run demo scan</button>
      </div>
      <GuidanceTip>Green tags are facts taken from the source. Blue tags are AI hypotheses — verify before acting. Scores rank opportunities; they don't prove novelty.</GuidanceTip>

      <Tabs defaultValue="opps">
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="opps">Opportunities</TabsTrigger>
          <TabsTrigger value="saved">Saved ({s.saved.length})</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="settings">Schedule & alerts</TabsTrigger>
        </TabsList>

        <TabsContent value="opps">
          <RuleBanner />
          <div className="mb-4 grid gap-2 sm:grid-cols-4">
            <input aria-label="Search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className={input} />
            <select aria-label="Sector" value={sector} onChange={(e) => setSector(e.target.value)} className={input}>
              <option value="all">All sectors</option>{sectors.map((x) => <option key={x}>{x}</option>)}
            </select>
            <select aria-label="Maturity" value={maturity} onChange={(e) => setMaturity(e.target.value)} className={input}>
              <option value="all">All maturity</option>{MATURITY.map((x) => <option key={x}>{x}</option>)}
            </select>
            <select aria-label="Research track" value={track} onChange={(e) => setTrack(e.target.value)} className={input}>
              <option value="all">Both tracks</option><option value="frontier">Frontier / underdog</option><option value="commercial">Commercial optimization</option>
            </select>
          </div>
          <FindingList items={findings} onBrief={setOpen} />
        </TabsContent>

        <TabsContent value="saved">
          <FindingList items={findings.filter((f) => s.saved.includes(f.id))} onBrief={setOpen} empty="No saved ideas yet." />
        </TabsContent>

        <TabsContent value="sources">
          <p className="mb-3 text-sm text-muted-foreground">Source registry. Toggles control which sources would be scanned. Some need API keys before live use.</p>
          <ul className="grid gap-3 md:grid-cols-2">
            {SOURCES.map((src) => (
              <li key={src.id} className="panel p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-silver">{src.name}</div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">{src.kind} · {src.access}</div>
                  </div>
                  <Switch aria-label={`Enable ${src.name}`} checked={!!s.sources[src.id]} onCheckedChange={(v) => setDiscovery((x) => ({ ...x, sources: { ...x.sources, [src.id]: v } }), `${v ? "enabled" : "disabled"} source ${src.name}`)} />
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Terms</dt><dd>{src.terms}</dd>
                  <dt className="text-muted-foreground">Rate limit</dt><dd>{src.rateLimit}</dd>
                  <dt className="text-muted-foreground">Endpoint</dt><dd className="truncate font-mono">{src.url}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </TabsContent>

        <TabsContent value="settings">
          <section className="panel mb-4 p-4" aria-labelledby="rule-set">
            <h2 id="rule-set" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-silver"><Scale className="h-4 w-4" />Research tracks</h2>
            <label className="mt-3 block text-sm">Attention reserved for frontier / underdog track: <strong className="text-electric">{s.frontierShare}%</strong>
              <input type="range" min={20} max={80} step={5} value={s.frontierShare} onChange={(e) => setDiscovery((x) => ({ ...x, frontierShare: Number(e.target.value) }), `frontier share set to ${e.target.value}%`)} className="mt-2 w-full accent-[var(--electric)]" aria-label="Frontier attention share" />
            </label>
            <p className="text-xs text-muted-foreground">Minimum 20% — the little-guy rule can't be switched off, only tuned. At least this share of ranked slots goes to frontier items when available.</p>
            <label className="mt-3 flex items-center gap-2 text-sm"><Switch checked={s.gemsOnly} onCheckedChange={(v) => setDiscovery((x) => ({ ...x, gemsOnly: v }), `overlooked-gems-only ${v ? "on" : "off"}`)} />Show only overlooked gems</label>
            <p className="mt-3 text-xs text-warning">Commercial track: authorized aggregated JAX feedback is not connected — commercial items use demo data only.</p>
          </section>
          <div className="grid gap-4 md:grid-cols-2">
            <section className="panel p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">Scheduled scans</h2>
              <select aria-label="Scan schedule" value={s.schedule} onChange={(e) => setDiscovery((x) => ({ ...x, schedule: e.target.value as typeof x.schedule }), `schedule set to ${e.target.value}`)} className={`${input} mt-3 w-full`}>
                <option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
              </select>
              <p className="mt-2 text-xs text-warning">Saved as a preference only. Scans won't run automatically until a backend with scheduling is enabled.</p>
              <button className="mt-4 rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive" onClick={() => setDiscovery((x) => ({ ...x, optIn: false, schedule: "off" }), "opted out; schedule turned off")}>Turn off Technology Discovery</button>
            </section>
            <section className="panel p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-silver"><Bell className="h-4 w-4" />Alerts</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <select aria-label="Alert sector" value={alertSector} onChange={(e) => setAlertSector(e.target.value)} className={input}>
                  <option value="all">Any sector</option>{sectors.map((x) => <option key={x}>{x}</option>)}
                </select>
                <input aria-label="Minimum score" type="number" min={0} max={100} value={alertMin} onChange={(e) => setAlertMin(Number(e.target.value))} className={`${input} w-24`} />
                <button className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground" onClick={() => setDiscovery((x) => ({ ...x, alerts: [...x.alerts, { id: crypto.randomUUID(), sector: alertSector, minScore: alertMin }] }), `alert added (${alertSector}, ≥${alertMin})`)}>Add alert</button>
              </div>
              <ul className="mt-3 space-y-2">
                {s.alerts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
                    <span>{a.sector === "all" ? "Any sector" : a.sector} · score ≥ {a.minScore} <span className="text-xs text-muted-foreground">({alertHits(a.sector, a.minScore)} demo matches)</span></span>
                    <button aria-label="Remove alert" onClick={() => setDiscovery((x) => ({ ...x, alerts: x.alerts.filter((y) => y.id !== a.id) }), "alert removed")}><Trash2 className="h-4 w-4 text-muted-foreground" /></button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">Alerts show in-app only. Email or push delivery needs a backend.</p>
            </section>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Prototype brief</DialogTitle></DialogHeader>
          {open && <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">{brief(open)}</pre>}
          <button className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" onClick={() => { if (open) navigator.clipboard?.writeText(brief(open)); toast("Brief copied"); }}>Copy brief</button>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FindingList({ items, onBrief, empty = "No findings match these filters." }: { items: Finding[]; onBrief: (f: Finding) => void; empty?: string }) {
  const s = useDiscovery();
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-3">
      {items.map((f) => {
        const saved = s.saved.includes(f.id);
        const src = SOURCES.find((x) => x.id === f.sourceId);
        const m = meta(f);
        const gem = gemReasons(f);
        const score = m.track === "frontier" ? frontierScore(f) : rankScore(f.scores);
        return (
          <li key={f.id} className="panel p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-semibold text-silver">{f.title}</h3>
                <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-wider">
                  <span className={`rounded border px-1.5 py-0.5 ${m.track === "frontier" ? "border-electric/50 text-electric" : "border-border text-silver-dim"}`}>{m.track === "frontier" ? "Frontier / underdog" : "Commercial"}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-silver-dim">{CREATOR_LABEL[m.creator]}</span>
                  <span className={`rounded border px-1.5 py-0.5 ${m.claimStatus === "validated" ? "border-success/50 text-success" : m.claimStatus === "reported" ? "border-warning/50 text-warning" : "border-destructive/50 text-destructive"}`}>{m.claimStatus === "validated" ? "Validated result" : m.claimStatus === "reported" ? "Reported, unverified" : "Speculative"}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{f.sector}</span><span>· {f.maturity}</span><span>· {src?.name}</span>
                  <span>· published {new Date(f.publishedAt).toLocaleDateString()}</span><span>· fetched {new Date(f.fetchedAt).toLocaleDateString()}</span>
                </div>
              </div>
              <div className="hex-clip flex h-12 w-14 flex-col items-center justify-center bg-secondary" aria-label={`${m.track === "frontier" ? "Frontier" : "Opportunity"} score ${score} of 100`}>
                <span className="font-display text-lg font-bold text-electric">{score}</span>
              </div>
            </div>
            {gem.length > 0 && (
              <div className="mt-3 rounded-md border border-electric/40 bg-accent/30 p-2 text-xs">
                <div className="flex items-center gap-1 font-semibold text-electric"><Gem className="h-3.5 w-3.5" />Overlooked gem — why</div>
                <ul className="mt-1 list-disc pl-5 text-accent-foreground">{gem.map((r) => <li key={r}>{r}</li>)}</ul>
                <p className="mt-1 text-muted-foreground">Ideas and IP belong to their creators. Contact and consent required before any collaboration or use.</p>
              </div>
            )}
            <div className="mt-3 space-y-2 text-sm">
              <p><Tag kind="fact">Source evidence</Tag> <span className="ml-1">{f.evidence}</span></p>
              <p><Tag kind="ai">AI gap</Tag> <span className="ml-1 text-muted-foreground">{f.gap}</span></p>
              <p><Tag kind="ai">AI idea</Tag> <span className="ml-1 text-muted-foreground">{f.idea}</span></p>
              <p><Tag kind="ai">Existing work (unverified)</Tag> <span className="ml-1 text-muted-foreground">{f.priorArt}</span></p>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
              {(["novelty", "feasibility", "impact", "confidence"] as const).map((k) => (
                <div key={k} className="rounded bg-muted py-1.5"><div className="text-silver">{f.scores[k]}/5</div><div className="capitalize text-muted-foreground">{k}</div></div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={f.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs"><ExternalLink className="h-3.5 w-3.5" />Original source (demo link)</a>
              <button aria-pressed={saved} onClick={() => setDiscovery((x) => ({ ...x, saved: saved ? x.saved.filter((i) => i !== f.id) : [...x.saved, f.id] }), `${saved ? "unsaved" : "saved"} idea "${f.title}"`)} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs">
                {saved ? <BookmarkCheck className="h-3.5 w-3.5 text-success" /> : <Bookmark className="h-3.5 w-3.5" />}{saved ? "Saved" : "Save idea"}
              </button>
              <button onClick={() => onBrief(f)} className="inline-flex items-center gap-1 rounded-md border border-electric/50 px-3 py-1.5 text-xs text-electric"><FlaskConical className="h-3.5 w-3.5" />Prototype brief</button>
              <SendToOmni finding={f} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RuleBanner() {
  return (
    <section aria-labelledby="rule" className="panel mb-4 border-electric/40 p-4">
      <h2 id="rule" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-electric"><Gem className="h-4 w-4" />Owner rule: “Never overlook the little guy.”</h2>
      <ul className="mt-2 grid gap-1 text-xs text-muted-foreground md:grid-cols-2">
        <li>Includes independent inventors, small labs, OSS maintainers, startups, students and pre-revenue prototypes.</li>
        <li>Funding, publicity, citations, team size and sales are never score inputs.</li>
        <li>Frontier score = novelty, feasibility, societal benefit, evidence confidence.</li>
        <li>Claims cited to original sources; speculation labelled. Creators keep their IP — no ownership claims.</li>
      </ul>
    </section>
  );
}
