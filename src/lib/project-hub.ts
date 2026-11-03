import { SITE_LABEL, SITE_TONE, type SiteStatus } from "./site-monitor";
// Pure rules for the simple owner project flow (Home, Projects, Connect, Project detail).

export type HubProject = { id: string; name: string; site_url: string | null; lovable_url: string | null; github_repo: string | null; site_status?: string | null; repo_sync_status?: string };
export type HubScan = { project_id: string; status: string; findings: unknown; created_at: string; error: string | null };
export type InventoryItem = { id: string; name: string; lovable_project_ref: string | null };

export type ProjectStatus = { label: string; tone: "ok" | "warn" | "error" | "muted" };

/** Status comes only from stored records: a project is never "healthy" without a finished scan. */
export function projectStatus(p: HubProject, lastScan: HubScan | undefined): ProjectStatus {
  if (p.repo_sync_status && p.repo_sync_status !== "linked") return { label: p.repo_sync_status === "deleted" ? "Repo deleted / not found" : "Repo out of sync — review", tone: "error" };
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
