// Pure Autopilot rules + static HTML scan analysis (tested in autopilot.test.ts).

export type Severity = "high" | "medium" | "low";
export type Finding = { severity: Severity; kind: string; url: string; message: string };

/** Autopilot ships for a project only when BOTH the master switch and the project switch are on. */
export const autopilotOn = (master: boolean, project: boolean) => master && project;

/** Paths Autopilot must never auto-ship; changes touching them always wait for the owner. */
const SENSITIVE = [/(^|\/)\.env/i, /(^|\/)\.github\//i, /auth/i, /supabase\//i, /migrations?\//i, /payment|stripe|billing|checkout/i, /secret|credential|password|token/i, /security|permission|role/i, /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml)$/i];
export function sensitiveFiles(paths: string[]): string[] {
  return paths.filter((p) => SENSITIVE.some((r) => r.test(p)));
}

/** Decides whether an open Autopilot PR may be merged without the owner. */
export function canAutoShip(o: { master: boolean; project: boolean; checks: string | null; paths: string[] }): { ok: boolean; reason: string } {
  if (!autopilotOn(o.master, o.project)) return { ok: false, reason: "Autopilot is off" };
  const s = sensitiveFiles(o.paths);
  if (s.length) return { ok: false, reason: `Touches sensitive files (${s.join(", ")}) — owner approval required` };
  if (o.checks === "success") return { ok: true, reason: "Checks passed" };
  if (o.checks === "failure") return { ok: false, reason: "Checks failed" };
  if (o.checks === "none") return { ok: false, reason: "Repo has no automated checks — owner approval required" };
  return { ok: false, reason: "Waiting for checks" };
}

/** Next patch version (1.2.3 → 1.2.4); starts at 0.1.0 with no history. */
export function nextPatch(latest: string | null): string {
  const m = latest?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "0.1.0";
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Extracts absolute http(s) link targets from HTML, resolved against the page URL. */
export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1]!.trim(), base);
      if (u.protocol === "http:" || u.protocol === "https:") { u.hash = ""; out.add(u.toString()); }
    } catch { /* ignore bad hrefs */ }
  }
  return [...out];
}

/** Static checks on one page's HTML (no JavaScript is run). */
export function analyzeHtml(html: string, url: string): Finding[] {
  const f: Finding[] = [];
  const add = (severity: Severity, kind: string, message: string) => f.push({ severity, kind, url, message });
  if (!/<title>\s*[^<\s][^<]*<\/title>/i.test(html)) add("medium", "seo", "Page has no title.");
  if (!/<meta[^>]+name=["']description["'][^>]+content=["'][^"']+/i.test(html) && !/<meta[^>]+content=["'][^"']+["'][^>]+name=["']description["']/i.test(html)) add("low", "seo", "Page has no meta description.");
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) add("medium", "mobile", "No viewport tag — page may not fit phones.");
  if (!/<html[^>]*\blang=/i.test(html)) add("low", "accessibility", "The <html> tag has no lang attribute.");
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].filter((m) => !/\balt\s*=/i.test(m[0])).length;
  if (imgs) add("low", "accessibility", `${imgs} image(s) without alt text.`);
  if (url.startsWith("https:") && /\b(src|href)=["']http:\/\//i.test(html)) add("medium", "security", "Loads insecure http:// resources on an https page.");
  for (const form of html.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    const body = form[0];
    const inputs = [...body.matchAll(/<(input|textarea|select)\b[^>]*>/gi)].filter((m) => !/type=["'](hidden|submit|button)["']/i.test(m[0]));
    const unlabeled = inputs.filter((m) => !/\b(aria-label|aria-labelledby|id)=/i.test(m[0])).length;
    if (unlabeled) add("medium", "forms", `A form has ${unlabeled} field(s) without a label.`);
    if (!/<button\b|type=["']submit["']/i.test(body)) add("high", "forms", "A form has no submit button.");
  }
  if (html.length > 1_500_000) add("medium", "performance", `Large HTML (${Math.round(html.length / 1024)} KB).`);
  return f;
}

export const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
export function sortFindings(f: Finding[]): Finding[] {
  return [...f].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}
