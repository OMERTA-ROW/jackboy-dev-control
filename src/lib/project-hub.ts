import { SITE_LABEL, SITE_TONE, type SiteStatus } from "./site-monitor";
// Pure rules for the simple owner project flow (Home, Projects, Connect, Project detail).

export type HubProject = { id: string; name: string; site_url: string | null; lovable_url: string | null; github_repo: string | null; site_status?: string | null; repo_sync_status?: string };
export type HubScan = { project_id: string; status: string; findings: unknown; created_at: string; error: string | null };
export type InventoryItem = { id: string; name: string; lovable_project_ref: string | null };

export type ProjectStatus = { label: string; tone: "ok" | "warn" | "error" | "muted" };

/** Status comes only from stored records: a project is never "healthy" without a finished scan. */
export function projectStatus(p: HubProject, lastScan: HubScan | undefined): ProjectStatus {
  if (p.repo_sync_status === "deleted") return { label: "Repo gone", tone: "error" };
  if (p.repo_sync_status === "moved") return { label: "Repo renamed — review", tone: "warn" };
  if (!p.site_url) return { label: "Needs site address", tone: "muted" };
  const ss = p.site_status as SiteStatus | undefined;
  if (ss && ss !== "connected" && ss !== "needs_address" && SITE_LABEL[ss]) return { label: SITE_LABEL[ss], tone: SITE_TONE[ss] };
  if (!lastScan) return { label: "Not scanned yet", tone: "muted" };
  if (lastScan.status === "running") return { label: "Scanning…", tone: "muted" };
  if (lastScan.status === "failed" || lastScan.error) return { label: "Scan failed", tone: "error" };
  const n = Array.isArray(lastScan.findings) ? lastScan.findings.length : 0;
  return n === 0 ? { label: "No issues in last scan", tone: "ok" } : { label: `${n} issue${n === 1 ? "" : "s"} found`, tone: "warn" };
}

/** Latest scan per project (input in any order). */
export function latestScans<T extends HubScan>(scans: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const s of scans) {
    const cur = out.get(s.project_id);
    if (!cur || s.created_at > cur.created_at) out.set(s.project_id, s);
  }
  return out;
}

const REF = /^[A-Za-z0-9-]{6,64}$/;
export function lovableUrl(ref: string): string | null {
  return REF.test(ref) ? `https://lovable.dev/projects/${ref}` : null;
}

/** Inventory entries that have a valid Lovable ID and are not already connected. */
export function availableInventory(items: InventoryItem[], connected: HubProject[]): InventoryItem[] {
  const used = new Set(connected.map((p) => p.lovable_url).filter(Boolean));
  return items.filter((i) => {
    const url = i.lovable_project_ref ? lovableUrl(i.lovable_project_ref) : null;
    return url !== null && !used.has(url);
  });
}

export function searchByName<T extends { name: string }>(list: T[], q: string): T[] {
  const t = q.trim().toLowerCase();
  return t ? list.filter((x) => x.name.toLowerCase().includes(t)) : list;
}

/** Simple main menu; everything else lives under Settings. */
export const MAIN_NAV = ["/", "/projects", "/connect", "/updates", "/chat", "/settings"] as const;

/** Accepts "example.com" or "https://example.com"; returns a normalized public https URL or null. */
export function normalizeSiteInput(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  const withScheme = /^[a-z]+:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return null;
    return u.toString().replace(/\/$/, "");
  } catch { return null; }
}

export type CardConnection = { label: string; tone: "ok" | "warn" | "error" | "muted"; detail: string; next: string | null; checkedAt: string | null };
/** Repo connection status from stored backend evidence only; never "Connected" without a verified read. */
export function cardConnection(p: { github_repo: string | null; repo_sync_status?: string }, check: { repo: string; checkedAt: string; exists: boolean; read: string; prWrite: string } | undefined): CardConnection {
  if (!p.github_repo) return { label: "Not connected", tone: "muted", detail: "No repo linked", next: "Press Connect to link a GitHub repo.", checkedAt: null };
  if (p.repo_sync_status === "deleted") return { label: "Repo not found", tone: "error", detail: `${p.github_repo} wasn't found by GitHub`, next: "Remove it or reconnect a different repo.", checkedAt: check?.checkedAt ?? null };
  if (!check || check.repo.toLowerCase() !== p.github_repo.toLowerCase()) return { label: "Not verified", tone: "warn", detail: `${p.github_repo} linked, access not checked yet`, next: "Press the refresh icon to verify access.", checkedAt: null };
  if (!check.exists) return { label: "Repo not visible", tone: "error", detail: `GitHub didn't show ${check.repo} to Jackboy`, next: "Check the GitHub App installation covers this repo, then refresh.", checkedAt: check.checkedAt };
  if (check.read !== "verified") return { label: "Access not verified", tone: "warn", detail: "Reading the repo wasn't confirmed", next: "Refresh, or reconnect to grant access.", checkedAt: check.checkedAt };
  if (check.prWrite !== "verified") return { label: "Connected (read only)", tone: "warn", detail: "Read verified; pull request write not verified", next: "Grant Pull requests: write to the GitHub App for this repo.", checkedAt: check.checkedAt };
  return { label: "Connected", tone: "ok", detail: "Read and pull request write verified", next: null, checkedAt: check.checkedAt };
}
