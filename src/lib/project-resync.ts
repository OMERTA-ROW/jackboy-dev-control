/** Only public https addresses are accepted as a detected site. */
export function isSafeSiteUrl(v: string): boolean {
  try { const u = new URL(v); return u.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname); } catch { return false; }
}
/** "honeycomb-terminal" → "Honeycomb Terminal"; keeps trailing-dash/odd names readable. */
export function repoNameToDisplay(name: string): string {
  return name.replace(/[-_]+/g, " ").trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A Lovable published address (*.lovable.app) is a site; the editor link (lovable.dev/projects/…) is not. */
export function publishedLovableUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  try { const u = new URL(v); return u.protocol === "https:" && /\.lovable\.app$/i.test(u.hostname) && !/^id-preview--/i.test(u.hostname) ? u.origin : null; } catch { return null; }
}
export type DeployStatus = { environment: string; environment_url: string | null; state: string };
/** Picks a live site from GitHub deployment statuses (Vercel/Netlify/Lovable report here); production first, previews ignored. */
export function pickDeploymentUrl(list: DeployStatus[]): string | null {
  const ok = list.filter((d) => d.state === "success" && d.environment_url && isSafeSiteUrl(d.environment_url) && !/preview/i.test(d.environment));
  const prod = ok.find((d) => /prod/i.test(d.environment)) ?? ok[0];
  return prod ? new URL(prod.environment_url!).origin : null;
}
/** Why a repo counts as dead for the archive review, or null. Never decides by itself; the owner confirms. */
export function deadReason(r: { state: "ok" | "gone" | "unlinked" | "unchecked"; archived?: boolean; pushedAt?: string | null }, now = Date.now()): string | null {
  if (r.state === "gone") return "Repo not found on GitHub";
  if (r.archived) return "Repo is archived on GitHub";
  if (r.pushedAt && now - new Date(r.pushedAt).getTime() > 365 * 86400_000) return `No code pushed since ${r.pushedAt.slice(0, 10)}`;
  return null;
}
