// Server-only updater controller: authenticates enrolled targets by hashed token, applies policy, records install phases, triggers rollback.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { checkForUpdate, evaluateRelease } from "./update-server.server";
import { compatFromConfig, policyCheck, stateAfter, type InstallPhase } from "./update-policy";
import { logSite } from "./site-log.server";

export const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

export async function targetFromRequest(request: Request) {
  const m = /^Bearer (jbt_[a-f0-9]{48})$/.exec(request.headers.get("authorization") ?? "");
  if (!m) return null;
  const { data } = await supabaseAdmin.from("update_targets").select("id, project_id, name, channel, platform, current_version, state, revoked_at").eq("token_hash", await sha256Hex(m[1]!)).maybeSingle();
  if (!data || data.revoked_at) return null;
  return data;
}
type Target = NonNullable<Awaited<ReturnType<typeof targetFromRequest>>>;

export async function targetCheck(t: Target, version: string) {
  await supabaseAdmin.from("update_targets").update({ current_version: version, last_seen_at: new Date().toISOString() }).eq("id", t.id);
  const res = await checkForUpdate(t.project_id, t.channel, version, t.id);
  if (!res.update) return { update: false };
  const manifest = res.manifest as { release_id: string; version: string; channel: string; config?: unknown; compatibility?: unknown };
  const { data: rel } = await supabaseAdmin.from("releases").select("status").eq("id", manifest.release_id).single();
  const policy = policyCheck({ status: rel?.status ?? "unknown", channel: manifest.channel, version: manifest.version, compatibility: compatFromConfig(manifest.config) },
    { channel: t.channel, platform: t.platform, current_version: version, revoked: false });
  if (!policy.allow) {
    await record(t, manifest.release_id, manifest.version, "policy_denied", policy.reasons.join("; "), `deny:${t.id}:${manifest.release_id}:${version}`);
    return { update: false, policy };
  }
  return { update: true, rollback: policy.rollback, policy, manifest: res.manifest, signature: res.signature, download_url: res.download_url };
}

async function record(t: Target, releaseId: string | null, version: string, phase: InstallPhase, detail: string, key: string) {
  const { error } = await supabaseAdmin.from("update_installs").insert({ target_id: t.id, release_id: releaseId, version, phase, detail: detail.slice(0, 500), idempotency_key: key });
  if (error?.code === "23505") return false; // duplicate report: idempotent no-op
  if (error) throw new Error("store_failed");
  return true;
}

export async function targetReport(t: Target, r: { release_id: string; version: string; phase: InstallPhase; detail: string; key: string }) {
  const { data: rel } = await supabaseAdmin.from("releases").select("id, project_id, channel").eq("id", r.release_id).maybeSingle();
  if (!rel || rel.project_id !== t.project_id) return { error: "unknown_release" as const };
  const fresh = await record(t, rel.id, r.version, r.phase, r.detail, `${t.id}:${r.key}`);
  if (!fresh) return { ok: true, duplicate: true };
  const patch: Record<string, unknown> = { state: stateAfter(r.phase), last_seen_at: new Date().toISOString(), last_release_id: rel.id };
  if (r.phase === "healthy" || r.phase === "rolled_back") patch["current_version"] = r.version;
  await supabaseAdmin.from("update_targets").update(patch).eq("id", t.id);
  let rolledBack = false;
  if (r.phase === "healthy" || r.phase === "failed") {
    await supabaseAdmin.from("health_reports").insert({ project_id: t.project_id, release_id: rel.id, version: r.version, channel: rel.channel, device_hash: await sha256Hex(`${t.project_id}:${t.id}`), kind: r.phase === "healthy" ? "ok" : "error", message: r.detail.slice(0, 500) });
    if (r.phase === "failed") rolledBack = await evaluateRelease(rel.id);
  }
  if (["installed", "healthy", "failed", "rolled_back"].includes(r.phase)) {
    await logSite({ actor: `updater:${t.name}`, action: `updater.${r.phase}`, category: r.phase === "rolled_back" ? "rollback" : r.phase === "failed" ? "error" : "deployment",
      status: r.phase === "failed" ? "failed" : r.phase === "rolled_back" ? "rolled_back" : "ok", project_id: t.project_id,
      summary: `Target "${t.name}" reported ${r.phase} for ${r.version}${rolledBack ? " — release auto-rolled back" : ""}.`, detail: { release_id: rel.id, target_id: t.id, detail: r.detail } });
  }
  return { ok: true, rolled_back: rolledBack };
}
