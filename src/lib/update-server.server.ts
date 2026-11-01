// Server-only update-server runtime used by public endpoints and the hourly job. Uses the admin client; callers validate input first.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CHANNELS, compareVersions, inRollout, nextRolloutPercent, pickRelease, shouldRollback, signingKeys, signPayload, type ReleaseStatus } from "./update-server";

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

/** Evaluates a rolling release's health; pauses and reverts it if the failure rate crosses the owner threshold. */
export async function evaluateRelease(releaseId: string) {
  const { data: r } = await supabaseAdmin.from("releases").select("id, project_id, version, channel, status, error_threshold, min_reports, published_at").eq("id", releaseId).maybeSingle();
  if (!r || r.status !== "rolling") return false;
  const since = r.published_at ?? new Date(0).toISOString();
  const [{ count: total }, { count: failures }] = await Promise.all([
    supabaseAdmin.from("health_reports").select("id", { count: "exact", head: true }).eq("release_id", r.id).gte("created_at", since),
    supabaseAdmin.from("health_reports").select("id", { count: "exact", head: true }).eq("release_id", r.id).gte("created_at", since).in("kind", ["error", "crash"]),
  ]);
  const counts = { total: total ?? 0, failures: failures ?? 0 };
  if (!shouldRollback(counts, Number(r.error_threshold), r.min_reports)) return false;
  const rate = ((counts.failures / counts.total) * 100).toFixed(1);
  const reason = `Auto-rollback: ${counts.failures}/${counts.total} reports failed (${rate}%) ≥ threshold ${r.error_threshold}%.`;
  const { data: updated } = await supabaseAdmin.from("releases").update({ status: "rolled_back", rollout_percent: 0, rollback_reason: reason })
    .eq("id", r.id).eq("status", "rolling").select("id");
  if (!updated?.length) return false;
  const { data: p } = await supabaseAdmin.from("owner_projects").select("name").eq("id", r.project_id).maybeSingle();
  await supabaseAdmin.from("audit_logs").insert({ actor: null, action: "releases.auto_rollback", detail: { release_id: r.id, version: r.version, channel: r.channel, ...counts }, outcome: "rolled_back" });
  await notify(`${p?.name ?? "Project"} ${r.version} (${r.channel}) was rolled back. ${reason} Devices revert to the previous release.`);
  return true;
}

/** Hourly: health checks for all rolling releases, then staged percent increases. */
export async function runReleaseJob() {
  const { data } = await supabaseAdmin.from("releases").select("id, rollout_percent, auto_step, step_hours, last_step_at, published_at").eq("status", "rolling");
  let rolledBack = 0, stepped = 0;
  for (const r of data ?? []) {
    if (await evaluateRelease(r.id)) { rolledBack++; continue; }
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
