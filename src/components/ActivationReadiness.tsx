import { integrationReadiness, liveReadiness } from "@/lib/activation-readiness";

export function ActivationReadiness({ live }: { live: Parameters<typeof liveReadiness>[0] | null }) {
  const items = [...(live ? liveReadiness(live) : []), ...integrationReadiness];
  return <div className="mt-6 border-t border-border pt-4" aria-labelledby="activation-readiness-heading">
    <h3 id="activation-readiness-heading" className="text-sm font-semibold text-silver">Dated readiness evidence</h3>
    <p className="mt-1 text-xs text-muted-foreground">Activation locked · dated observations, not authorization. Integration observations retain their original timestamps.</p>
    {!live && <p role="status" className="mt-2 text-xs text-warning">Live safety evidence unavailable; readiness remains blocked.</p>}
    <div className="mt-3 divide-y divide-border">
      {items.map((item) => <details key={item.name} className="py-3">
        <summary className="cursor-pointer text-sm"><span className={item.status === "PASS" ? "text-success" : "text-warning"}>{item.status}</span> · {item.name}</summary>
        <dl className="mt-2 space-y-1 break-words text-xs text-muted-foreground">
          <div><dt className="inline font-medium">Evidence: </dt><dd className="inline">{item.evidence}</dd></div>
          <div><dt className="inline font-medium">Checked: </dt><dd className="inline"><time dateTime={item.checkedAt}>{item.checkedAt}</time></dd></div>
          <div><dt className="inline font-medium">Changed: </dt><dd className="inline">{item.changed}</dd></div>
          <div><dt className="inline font-medium">Remaining: </dt><dd className="inline">{item.remaining}</dd></div>
          <div><dt className="inline font-medium">Next: </dt><dd className="inline">{item.next}</dd></div>
        </dl>
      </details>)}
    </div>
  </div>;
}