import type { ReactNode } from "react";
import { OctagonX, Power, RefreshCw, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { SafetyControlsView, UnmetRequirement } from "@/lib/safety-controls";

type Props = {
  view: SafetyControlsView;
  busy: boolean;
  onKillSwitchOn: () => void;
  onKillSwitchOff: () => void;
  onCodeOn: () => void;
  onCodeOff: () => void;
  onEngageStop: () => void;
  onReleaseStop: () => void;
  /** ISO time of the last live read; null when not read yet. */
  checkedAt?: string | null | undefined;
  onRefresh?: (() => void) | undefined;
};

function Badge({ tone, children }: { tone: "safe" | "live" | "unknown"; children: string }) {
  const cls =
    tone === "live"
      ? "border-success text-success"
      : tone === "safe"
        ? "border-warning text-warning"
        : "border-border text-muted-foreground";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${cls}`}>
      {children}
    </span>
  );
}

function Row({ n, title, badge, children }: { n: number; title: string; badge: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          <span className="text-muted-foreground">{n}.</span> {title}
        </h3>
        <span aria-live="polite">{badge}</span>
      </div>
      {children}
    </div>
  );
}

function UnmetList({ items, label }: { items: UnmetRequirement[]; label: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 text-xs" aria-label={label}>
      {items.map((u) => (
        <li key={u.id}>
          <span className="text-warning">
            <span aria-hidden>✗ </span>
            Needs: {u.label}.{u.detail ? ` Now: ${u.detail}` : ""}
          </span>
          <span className="block text-muted-foreground">How to fix: {u.fix}</span>
        </li>
      ))}
    </ul>
  );
}

/** The three separate owner safety controls. Each has its own saved setting and its own
 * passkey-protected action; the server and database re-check each change and never change the
 * other two. Whether CODE can actually run is shown separately at the bottom. */
export function SafetyControls({ view, busy, onKillSwitchOn, onKillSwitchOff, onCodeOn, onCodeOff, onEngageStop, onReleaseStop, checkedAt, onRefresh }: Props) {
  const { killSwitch: ks, code, emergencyStop: es, execution } = view;
  const time = checkedAt ? new Date(checkedAt).toISOString().slice(11, 19) : null;
  return (
    <div className="mt-3 space-y-3" aria-label="Safety controls">
      <Row
        n={1}
        title="System Kill Switch"
        badge={<Badge tone={ks.status === "off" ? "live" : ks.status === "on" ? "safe" : "unknown"}>{ks.status === "unknown" ? "Unknown" : ks.status === "on" ? "On" : "Off"}</Badge>}
      >
        <p className="mt-1 text-xs text-muted-foreground">{ks.effect}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={busy || !ks.canToggle}
          aria-pressed={ks.status === "on"}
          onClick={ks.status === "on" ? onKillSwitchOff : onKillSwitchOn}
        >
          <Power aria-hidden />
          {ks.status === "on" ? "Turn Kill Switch off" : "Turn Kill Switch on"}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">Needs your passkey.</p>
        {ks.lockReason && <p className="mt-1 text-xs text-warning">{ks.lockReason}</p>}
      </Row>

      <Row
        n={2}
        title="CODE enabled (saved setting)"
        badge={<Badge tone={code.status === "on" ? "live" : code.status === "off" ? "safe" : "unknown"}>{code.status === "unknown" ? "Unknown" : code.status === "on" ? "Saved ON" : "Saved OFF"}</Badge>}
      >
        <div className="mt-2 flex items-center gap-3">
          <Switch
            id="code-enabled-switch"
            checked={code.status === "on"}
            disabled={busy || !(code.canTurnOn || code.canTurnOff)}
            aria-describedby="code-enabled-effect code-enabled-lock"
            onCheckedChange={(next) => (next ? onCodeOn() : onCodeOff())}
          />
          <label htmlFor="code-enabled-switch" className="text-sm">
            CODE enabled
          </label>
          <span className="text-xs text-muted-foreground">Needs a new passkey.</span>
        </div>
        <p id="code-enabled-effect" className="mt-1 text-xs text-muted-foreground">
          {code.effect} {code.canTurnOn ? "Every requirement passes; nothing happens until you press." : null}
        </p>
        <div id="code-enabled-lock">
          {code.lockReason && <p className="mt-2 text-xs font-medium text-warning">{code.lockReason}</p>}
          {view.independent && <UnmetList items={code.unmet} label="Requirements not met" />}
        </div>
      </Row>

      <Row
        n={3}
        title="CODE Emergency Stop"
        badge={<Badge tone={es.status === "released" ? "live" : es.status === "engaged" ? "safe" : "unknown"}>{es.status === "unknown" ? "Unknown" : es.status === "engaged" ? "Engaged" : "Released"}</Badge>}
      >
        <p className="mt-1 text-xs text-muted-foreground">{es.effect}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="destructive" size="sm" disabled={busy || !es.canEngage} onClick={onEngageStop}>
            <OctagonX aria-hidden />
            {es.status === "engaged" ? "Emergency stop engaged" : "Engage emergency stop"}
          </Button>
          {es.status === "engaged" && (
            <Button variant="outline" size="sm" disabled={busy || !es.canRelease} onClick={onReleaseStop} aria-describedby="stop-release-lock">
              <Unlock aria-hidden />
              Release emergency stop
            </Button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Engaging needs your passkey and is never blocked by other checks. Releasing needs a new passkey.
        </p>
        <div id="stop-release-lock">
          {es.lockReason && es.status === "engaged" && <p className="mt-2 text-xs font-medium text-warning">{es.lockReason}</p>}
          {view.independent && <UnmetList items={es.releaseUnmet} label="Release requirements not met" />}
        </div>
      </Row>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
        <p aria-live="polite">
          <span className="font-medium">Saved CODE setting: </span>
          <span>{code.status === "unknown" ? "unknown" : code.status === "on" ? "ON" : "OFF"}</span>
          <span aria-hidden> · </span>
          <span className="font-medium">Can CODE run right now? </span>
          {execution.allowed ? (
            <span className="text-success">Yes — each run still needs your approval in GitHub.</span>
          ) : (
            <span className="text-warning">No — {execution.blockedBy.join(" · ")}.</span>
          )}
        </p>
        {onRefresh && (
          <span className="flex items-center gap-2 text-muted-foreground">
            {time ? `Checked ${time} UTC · refreshes on its own` : "Checking…"}
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
              <RefreshCw aria-hidden /> Refresh
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
