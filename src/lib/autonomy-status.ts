// Pure rules for "What's really running": separates Lovable-side owner switches, the evidence that background
// jobs actually fire, GitHub CODE execution gates, and owner-only permissions. A switch being on is never treated
// as proof that work runs; only fresh run records count. Read-only — this module decides nothing.

export type RowState = "running" | "on" | "off" | "not_running" | "blocked" | "unverified";
export type StatusRow = { id: string; label: string; state: RowState; detail: string; fix?: string };

export type AutonomyInput = {
  now: number;
  killSwitch: boolean | null;
  projects: { name: string; repo: string | null; devEnabled: boolean; autopilot: boolean }[];
  autopilotMaster: boolean;
  pauseReason: string | null;
  foundry: { enabled: boolean; paused: boolean; lastTickAt: string | null } | null;
  updateWriterLastRunAt: string | null;
  siteCheckedAt: string | null;
  alertsHeartbeatAt: string | null;
  code: {
    enabled: boolean; killSwitch: boolean; hardCap: boolean; meterOk: boolean | null;
    failures: number; activeRun: boolean; targets: string[];
  } | null;
  omniVerified: boolean;
};

export const OWNER_ONLY = [
  "Merging pull requests (only exception: Undo may merge its own revert after your fresh passkey and passing checks)",
  "Publishing the site and production deployments",
  "Adding, changing or reading secrets",
  "Billing, credits and spending limits",
  "GitHub permissions, environments and workflow files",
] as const;

const HOUR = 3600_000;

export function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 90_000) return "just now";
  if (ms < HOUR) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)} h ago`;
  return `${Math.round(ms / (24 * HOUR))} days ago`;
}

export function fresh(iso: string | null, now: number, maxMs: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && now - t <= maxMs;
}

export function summarizeAutonomy(i: AutonomyInput) {
  const active = i.projects;
  const bg = active.filter((p) => p.devEnabled);
  const bgRepo = bg.filter((p) => p.repo);
  const ap = active.filter((p) => p.autopilot);
  const hourlyFresh = fresh(i.foundry?.lastTickAt ?? null, i.now, 2 * HOUR);
  const killed = i.killSwitch !== false;
  const foundryOn = Boolean(i.foundry?.enabled && !i.foundry.paused);

  const lovable: StatusRow[] = [
    i.killSwitch === null
      ? { id: "kill", label: "Kill Switch", state: "unverified", detail: "Couldn't read it, so all work is treated as paused." }
      : i.killSwitch
        ? { id: "kill", label: "Kill Switch", state: "blocked", detail: "On. It overrides every switch below; no Jackboy work starts." }
        : { id: "kill", label: "Kill Switch", state: "off", detail: "Off. Work is allowed where the switches below are on." },
    {
      id: "background", label: "Background work switches", state: bg.length ? "on" : "off",
      detail: bg.length
        ? `On for ${bg.length} of ${active.length} projects; ${bgRepo.length} of those have a GitHub repo, so only they can be inspected.`
        : "Off for every project.",
      ...(bg.length > bgRepo.length ? { fix: `Link a repo to the other ${bg.length - bgRepo.length} on the Projects page.` } : {}),
    },
    {
      id: "foundry", label: "Recurring inspections (what makes background work run on its own)", state: foundryOn ? "on" : "off",
      detail: foundryOn
        ? "On: one budgeted inspection per due period, next project in rotation."
        : `Off${i.foundry?.paused ? " and paused" : ""}. Background work only runs when you start a loop yourself.`,
      ...(foundryOn ? {} : { fix: "Turn on in Code Foundry → schedule." }),
    },
    {
      id: "autopilot", label: "Autopilot master switch", state: i.autopilotMaster ? "on" : "off",
      detail: i.autopilotMaster
        ? `On. ${ap.length} project${ap.length === 1 ? "" : "s"} allowed to ship low-risk fixes after checks pass.`
        : ap.length
          ? `Off, so the Autopilot switch on ${ap.length} project${ap.length === 1 ? "" : "s"} (${ap.map((p) => p.name).join(", ")}) does nothing.`
          : "Off.",
    },
  ];
  if (i.pauseReason) lovable.push({
    id: "hold", label: "Scheduled fix writing", state: "blocked",
    detail: `Held: "${i.pauseReason}". Scheduled fix writing and Autopilot shipping skip until it's cleared.`,
    fix: "Updates page → Resume schedule, once the cause is fixed.",
  });

  const sched = (id: string, label: string, at: string | null, maxMs: number, what: string): StatusRow =>
    fresh(at, i.now, maxMs)
      ? { id, label, state: "running", detail: `Last ran ${ago(at, i.now)}. ${what}` }
      : { id, label, state: "not_running", detail: `No run record in the expected window (last: ${ago(at, i.now)}). ${what}` };
  const schedules: StatusRow[] = [
    { ...sched("hourly", "Hourly job", i.foundry?.lastTickAt ?? null, 2 * HOUR, "Runs recurring inspections, Autopilot, Task Mode steps and log delivery."),
      ...(hourlyFresh ? {} : { fix: "Its schedule is switched off. Ask Jackboy's builder to turn it on." }) },
    sched("writer", "Scheduled fix writer", i.updateWriterLastRunAt, 26 * HOUR, "Writes fix proposals for due projects."),
    sched("sites", "Site monitor", i.siteCheckedAt, 2 * HOUR, "Checks each connected site address."),
    sched("alerts", "Phone alerts and morning report", i.alertsHeartbeatAt, 75 * 60_000, "Read-only: sends alerts and the 7 AM report."),
  ];

  const unattended = !killed && hourlyFresh && (foundryOn || i.autopilotMaster) && !i.pauseReason;
  const lovableHeadline = killed
    ? "Paused by the Kill Switch — nothing runs."
    : unattended
      ? "Running on its own inside the switches you set."
      : bg.length
        ? `Switched on for ${bg.length} projects, but nothing runs on its own right now — ${!hourlyFresh ? "the hourly job isn't firing" : !foundryOn && !i.autopilotMaster ? "recurring inspections and Autopilot are off" : "a hold is active"}. Work runs only when you start it.`
        : "Off. Work runs only when you start it.";

  const c = i.code;
  const codeRows: StatusRow[] = !c
    ? [{ id: "code", label: "CODE controls", state: "unverified", detail: "Couldn't read CODE controls; treat CODE as off." }]
    : [
        { id: "code-on", label: "CODE execution", state: c.enabled && !c.killSwitch ? "on" : "off", detail: c.enabled ? (c.killSwitch ? "Switched on, but its emergency stop is engaged." : "On. Every run still waits for your approval in GitHub.") : "Off." },
        { id: "code-stop", label: "CODE emergency stop", state: c.killSwitch ? "blocked" : "off", detail: c.killSwitch ? "Engaged — CODE can't run." : "Released." },
        { id: "code-sites", label: "Allowed sites", state: c.targets.length ? "on" : "blocked", detail: c.targets.length ? c.targets.join(", ") : "None — CODE refuses every repository." },
        { id: "code-cap", label: "Provider hard cap", state: c.hardCap ? "on" : "blocked", detail: c.hardCap ? "Marked verified by you." : "Not marked." },
        { id: "code-meter", label: "Spending meter ($5/day, $10 total)", state: c.meterOk === true ? "on" : c.meterOk === false ? "blocked" : "unverified", detail: c.meterOk === true ? "Healthy." : c.meterOk === false ? "Blocking runs." : "No reading yet." },
        { id: "code-fail", label: "Failures in a row", state: c.failures >= 2 ? "blocked" : "on", detail: `${c.failures} of 2 (two stops CODE automatically).` },
        { id: "code-run", label: "Active run", state: c.activeRun ? "running" : "off", detail: c.activeRun ? "A CODE run is in progress." : "None." },
      ];
  const codeHeadline = !c ? "Unknown — treated as off." : c.enabled && !c.killSwitch ? "On — each run needs your GitHub approval." : "Off.";
  const omni: StatusRow = i.omniVerified
    ? { id: "omni", label: "OMNI build link", state: "on", detail: "Verified." }
    : { id: "omni", label: "OMNI build link", state: "blocked", detail: "Not verified. OMNI receives no build or test work." };

  return { lovable, schedules, code: codeRows, omni, ownerOnly: [...OWNER_ONLY], headline: { lovable: lovableHeadline, code: codeHeadline }, unattended };
}
