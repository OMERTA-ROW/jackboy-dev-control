// Server-only update-server runtime used by public endpoints and the hourly job. Uses the admin client; callers validate input first.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CHANNELS, compareVersions, enrolledTargetHealth, inRollout, nextRolloutPercent, pickRelease, shouldRollback, signingKeys, signPayload, type ReleaseStatus } from "./update-server";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

let cached: Awaited<ReturnType<typeof signingKeys>> | null = null;
export async function keys() {
  const secret = process.env["JACKBOY_SIGNING_SECRET"];
  if (!secret) return null;
  cached ??= await signingKeys(secret);
  return cached;
}

export async function projectByKey(clientKey: string) {
  const { data } = await supabaseAdmin.from("owner_projects").select("id, name").eq("client_key", clientKey).maybeSingle();
  return data;
}

type Rel = { id: string; version: string; status: ReleaseStatus; rollout_percent: number; manifest: unknown; signature: string | null; artifact_path: string | null };

export async function checkForUpdate(projectId: string, channel: string, version: string, device: string) {
  const { data } = await supabaseAdmin.from("releases").select("id, version, status, rollout_percent, manifest, signature, artifact_path")
    .eq("project_id", projectId).eq("channel", channel).in("status", ["rolling", "complete"]);
  const target = pickRelease((data ?? []) as Rel[], device);
  if (!target || !target.manifest || !target.signature) return { update: false as const };
  const cmp = compareVersions(target.version, version);
  if (cmp === 0) return { update: false as const, current: target.version };
  let download_url: string | null = null;
  if (target.artifact_path) {
    const { data: s } = await supabaseAdmin.storage.from("release-artifacts").createSignedUrl(target.artifact_path, 3600);
    download_url = s?.signedUrl ?? null;
  }
  return { update: true as const, downgrade: cmp < 0, manifest: target.manifest, signature: target.signature, download_url };
}

export async function flagsFor(projectId: string, channel: string, device: string) {
  const { data } = await supabaseAdmin.from("feature_flags").select("key, enabled, rollout_percent").eq("project_id", projectId).eq("channel", channel);
  const flags: Record<string, boolean> = {};
  for (const f of data ?? []) flags[f.key] = f.enabled && inRollout(device, `${projectId}:${f.key}`, f.rollout_percent);
  return flags;
}

async function notify(message: string) {
  await supabaseAdmin.from("owner_notifications").insert({ kind: "rollback", message, email_state: "not_configured" });
}

export type ReleaseAssessment = { rolledBack: boolean; held: boolean };

/**
 * Evaluates a rolling release's health.
 * Automatic rollback is decided only from enrolled update targets (authenticated reports, one vote
 * per target). Anonymous public health reports can be forged with invented device ids, so when they
 * alone cross the threshold Jackboy alerts the owner once and holds automatic rollout increases;
 * the owner decides on the Releases page whether to roll back.
 */
export async function assessRelease(releaseId: string): Promise<ReleaseAssessment> {
  const none = { rolledBack: false, held: false };
  const { data: r } = await supabaseAdmin.from("releases").select("id, project_id, version, channel, status, error_threshold, min_reports, published_at").eq("id", releaseId).maybeSingle();
  if (!r || r.status !== "rolling") return none;
  const since = r.published_at ?? new Date(0).toISOString();
  const threshold = Number(r.error_threshold);

  const { data: installs, error: installsError } = await supabaseAdmin.from("update_installs").select("target_id, phase")
    .eq("release_id", r.id).gte("created_at", since).in("phase", ["healthy", "failed"])
    .order("created_at", { ascending: false }).limit(5000);
  const trusted = installsError ? { total: 0, failures: 0 } : enrolledTargetHealth(installs ?? []);
  if (shouldRollback(trusted, threshold, r.min_reports)) {
    const rate = ((trusted.failures / trusted.total) * 100).toFixed(1);
    const reason = `Auto-rollback: ${trusted.failures}/${trusted.total} enrolled targets reported failure (${rate}%) ≥ threshold ${r.error_threshold}%.`;
    const { data: updated } = await supabaseAdmin.from("releases").update({ status: "rolled_back", rollout_percent: 0, rollback_reason: reason })
      .eq("id", r.id).eq("status", "rolling").select("id");
    if (!updated?.length) return none;
    const { data: p } = await supabaseAdmin.from("owner_projects").select("name").eq("id", r.project_id).maybeSingle();
    await supabaseAdmin.from("audit_logs").insert({ actor: null, action: "releases.auto_rollback", detail: { release_id: r.id, version: r.version, channel: r.channel, source: "enrolled_targets", ...trusted }, outcome: "rolled_back" });
    await notify(`${p?.name ?? "Project"} ${r.version} (${r.channel}) was rolled back. ${reason} Devices revert to the previous release.`);
    return { rolledBack: true, held: false };
  }

  const [{ count: total }, { count: failures }] = await Promise.all([
    supabaseAdmin.from("health_reports").select("id", { count: "exact", head: true }).eq("release_id", r.id).gte("created_at", since),
    supabaseAdmin.from("health_reports").select("id", { count: "exact", head: true }).eq("release_id", r.id).gte("created_at", since).in("kind", ["error", "crash"]),
  ]);
  const reported = { total: total ?? 0, failures: failures ?? 0 };
  if (!shouldRollback(reported, threshold, r.min_reports)) return none;
  // Unverified reports: hold growth and alert the owner once per release; never roll back on them.
  const { count: alerted } = await supabaseAdmin.from("audit_logs").select("id", { count: "exact", head: true })
    .eq("action", "releases.health_alert").eq("detail->>release_id", r.id);
  if (!alerted) {
    const rate = ((reported.failures / reported.total) * 100).toFixed(1);
    const { data: p } = await supabaseAdmin.from("owner_projects").select("name").eq("id", r.project_id).maybeSingle();
    await supabaseAdmin.from("audit_logs").insert({ actor: null, action: "releases.health_alert", detail: { release_id: r.id, version: r.version, channel: r.channel, source: "public_reports", ...reported }, outcome: "held" });
    await notify(`${p?.name ?? "Project"} ${r.version} (${r.channel}): ${reported.failures}/${reported.total} unverified device reports failed (${rate}%) ≥ threshold ${r.error_threshold}%. Automatic rollout increases are on hold. Review it on the Releases page and roll back there if needed.`);
  }
  return { rolledBack: false, held: true };
}

/** True only when the release was rolled back on enrolled-target evidence. */
export async function evaluateRelease(releaseId: string): Promise<boolean> {
  return (await assessRelease(releaseId)).rolledBack;
}

/** Hourly: health checks for all rolling releases, then staged percent increases. */
export async function runReleaseJob() {
  const { data } = await supabaseAdmin.from("releases").select("id, rollout_percent, auto_step, step_hours, last_step_at, published_at").eq("status", "rolling");
  let rolledBack = 0, stepped = 0;
  for (const r of data ?? []) {
    const health = await assessRelease(r.id);
    if (health.rolledBack) { rolledBack++; continue; }
    if (health.held) continue; // unverified failure reports: owner reviews before the rollout grows
    if (r.auto_step <= 0 || r.rollout_percent >= 100) continue;
    const last = new Date(r.last_step_at ?? r.published_at ?? 0).getTime();
    if (Date.now() - last < r.step_hours * 3600_000) continue;
    const pct = nextRolloutPercent(r.rollout_percent, r.auto_step);
    await supabaseAdmin.from("releases").update({ rollout_percent: pct, last_step_at: new Date().toISOString() }).eq("id", r.id).eq("status", "rolling");
    await supabaseAdmin.from("audit_logs").insert({ actor: null, action: "releases.rollout_step", detail: { release_id: r.id, from: r.rollout_percent, to: pct }, outcome: "ok" });
    stepped++;
  }
  return { rolledBack, stepped };
}

export { CHANNELS, signPayload };
