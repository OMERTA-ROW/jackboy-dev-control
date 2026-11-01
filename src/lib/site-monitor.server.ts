// Server-only site probes: DNS over HTTPS + one HTTPS GET with timeout. Results are stored with evidence.
import { classify, nextCheckDelay, validateSiteUrl, type Probe, type SiteStatus } from "./site-monitor";

async function resolve(host: string): Promise<Probe["dns"]> {
  try {
    const out: string[] = [];
    for (const type of ["A", "AAAA"]) {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { Status: number; Answer?: { type: number; data: string }[] };
      for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
    }
    return out.length ? { ok: true, addresses: out.slice(0, 6) } : { ok: false, addresses: [], error: `DNS: ${host} has no A/AAAA records.` };
  } catch (e) { return { ok: false, addresses: [], error: `DNS lookup failed: ${(e as Error).message}` }; }
}

export async function probeSite(input: string) {
  const v = validateSiteUrl(input);
  if (!v.ok) return { status: (input ? "error" : "needs_address") as SiteStatus, evidence: { reason: v.reason } };
  const dns = await resolve(v.host);
  const probe: Probe = { dns };
  if (dns.ok) {
    const t = Date.now();
    try {
      const r = await fetch(v.url, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Jackboy-SiteMonitor/1" } });
      probe.http = { status: r.status, ms: Date.now() - t, finalUrl: r.url };
      await r.body?.cancel();
    } catch (e) { probe.http = { error: (e as Error).name === "TimeoutError" ? "HTTPS request timed out after 10 s." : `HTTPS failed: ${(e as Error).message}`, ms: Date.now() - t }; }
  }
  const c = classify(probe);
  return { status: c.status, evidence: { reason: c.reason, url: v.url, host: v.host, dns: probe.dns, http: probe.http ?? null } };
}

type Row = { id: string; site_url: string | null; site_fail_count: number; site_status: string };
/** Probes and stores one project. Logs only status changes to the Site Log. */
export async function checkAndStore(db: any, p: Row, actor: string) {
  const r = await probeSite(p.site_url ?? "");
  const fails = r.status === "connected" ? 0 : p.site_fail_count + 1;
  const delay = nextCheckDelay(r.status, fails);
  const now = new Date();
  await db.from("owner_projects").update({ site_status: r.status, site_checked_at: now.toISOString(), site_evidence: r.evidence, site_fail_count: fails, site_next_check_at: Number.isFinite(delay) ? new Date(now.getTime() + delay).toISOString() : null }).eq("id", p.id);
  if (r.status !== p.site_status) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("site_log").insert({ project_id: p.id, actor, action: "site_check", category: "connectivity", status: r.status, summary: `Site status ${p.site_status} → ${r.status}: ${r.evidence.reason}`, detail: r.evidence });
  }
  return { id: p.id, ...r };
}

/** Scheduled pass: only monitored projects with an address whose next check is due. Bounded to 20 per run. */
export async function runDueChecks() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("owner_projects").select("id,site_url,site_fail_count,site_status").eq("site_monitoring", true).not("site_url", "is", null).lte("site_next_check_at", new Date().toISOString()).limit(20);
  const out = [];
  for (const p of data ?? []) out.push(await checkAndStore(supabaseAdmin, p as Row, "scheduler"));
  return { checked: out.length };
}
