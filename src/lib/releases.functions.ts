import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CHANNELS, SEMVER, signingKeys, signPayload } from "./update-server";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}
const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });
const channel = z.enum(CHANNELS);
const uuid = z.string().uuid();

export type ReleaseRow = { id: string; project_id: string; version: string; channel: string; notes: string; status: string; rollout_percent: number; auto_step: number; step_hours: number; error_threshold: number; min_reports: number; artifact_path: string | null; artifact_sha256: string | null; artifact_size: number | null; signature: string | null; rollback_reason: string | null; published_at: string | null; created_at: string; config: Record<string, any> | null };
export type FlagRow = { id: string; project_id: string; channel: string; key: string; enabled: boolean; rollout_percent: number; description: string };

export const getReleaseData = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const [p, r, f, h] = await Promise.all([
    context.supabase.from("owner_projects").select("id, name, client_key").order("name"),
    context.supabase.from("releases").select("*").order("created_at", { ascending: false }).limit(300),
    context.supabase.from("feature_flags").select("*").order("key"),
    context.supabase.from("health_reports").select("release_id, kind").gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString()).limit(5000),
  ]);
  for (const x of [p, r, f, h]) if (x.error) throw new Error(x.error.message);
  const health: Record<string, { total: number; failures: number }> = {};
  for (const row of h.data as { release_id: string | null; kind: string }[]) {
    if (!row.release_id) continue;
    const e = (health[row.release_id] ??= { total: 0, failures: 0 });
    e.total++; if (row.kind !== "ok") e.failures++;
  }
  const secret = process.env["JACKBOY_SIGNING_SECRET"];
  const publicKey = secret ? (await signingKeys(secret)).publicKeyBase64 : null;
  return { projects: p.data as { id: string; name: string; client_key: string }[], releases: r.data as ReleaseRow[], flags: f.data as FlagRow[], health, publicKey };
});

const releaseInput = z.object({
  project_id: uuid, version: z.string().trim().regex(SEMVER, "Version must be semantic, e.g. 1.4.0").max(64), channel,
  notes: z.string().trim().max(5000), config: z.string().max(20000),
  rollout_percent: z.number().int().min(0).max(100), auto_step: z.number().int().min(0).max(100), step_hours: z.number().int().min(1).max(720),
  error_threshold: z.number().gt(0).max(100), min_reports: z.number().int().min(1).max(100000),
  artifact_path: z.string().max(400).regex(/^[0-9a-f-]{36}\/[A-Za-z0-9._-]+$/).nullable(),
});

export const createRelease = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => releaseInput.parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    let config: any = {};
    if (data.config.trim()) { try { config = JSON.parse(data.config); } catch { throw new Error("Config must be valid JSON."); } }
    if (data.artifact_path && !data.artifact_path.startsWith(data.project_id + "/")) throw new Error("Artifact belongs to another project.");
    const { error } = await context.supabase.from("releases").insert({ ...data, config, created_by: context.userId });
    if (error) throw new Error(error.message.includes("duplicate") ? "That version already exists on this channel." : error.message);
    await audit(context, "releases.create", { project_id: data.project_id, version: data.version, channel: data.channel });
    return { ok: true };
  });

/** Signs and starts a draft release. Hashes the stored artifact so clients can verify the download. */
export const publishRelease = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const secret = process.env["JACKBOY_SIGNING_SECRET"];
    if (!secret) throw new Error("Signing key is not configured on the server.");
    const { data: r, error } = await context.supabase.from("releases").select("*, owner_projects(client_key)").eq("id", data.id).single();
    if (error) throw new Error(error.message);
    if (r.status !== "draft") throw new Error("Only drafts can be published.");
    let artifact: { file: string; sha256: string; size: number } | null = null;
    if (r.artifact_path) {
      const { data: blob, error: dl } = await context.supabase.storage.from("release-artifacts").download(r.artifact_path);
      if (dl || !blob) throw new Error("Could not read the uploaded bundle.");
      const buf = await blob.arrayBuffer();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)), (b) => b.toString(16).padStart(2, "0")).join("");
      artifact = { file: r.artifact_path.split("/").pop()!, sha256, size: buf.byteLength };
    }
    const published_at = new Date().toISOString();
    const manifest = { issuer: "jackboy", project: r.owner_projects.client_key, release_id: r.id, version: r.version, channel: r.channel, notes: r.notes, config: r.config, artifact, published_at };
    const { signature } = await signPayload((await signingKeys(secret)).privateKey, manifest);
    const { error: up } = await context.supabase.from("releases").update({ status: "rolling", manifest, signature, published_at, last_step_at: published_at, artifact_sha256: artifact?.sha256 ?? null, artifact_size: artifact?.size ?? null }).eq("id", r.id).eq("status", "draft");
    if (up) throw new Error(up.message);
    await audit(context, "releases.publish", { release_id: r.id, version: r.version, channel: r.channel, percent: r.rollout_percent });
    return { ok: true };
  });

const TRANSITIONS: Record<string, string[]> = { pause: ["rolling"], resume: ["paused"], complete: ["rolling", "paused"], rollback: ["rolling", "paused", "complete"] };
export const changeRelease = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid, action: z.enum(["pause", "resume", "complete", "rollback", "percent"]), percent: z.number().int().min(0).max(100).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { data: r, error } = await context.supabase.from("releases").select("id, status, version, channel").eq("id", data.id).single();
    if (error) throw new Error(error.message);
    let patch: { status?: string; rollout_percent?: number; last_step_at?: string; rollback_reason?: string };
    if (data.action === "percent") {
      if (!["rolling", "paused", "draft"].includes(r.status)) throw new Error("Percent can only change before completion.");
      patch = { rollout_percent: data.percent ?? 0, last_step_at: new Date().toISOString() };
    } else {
      if (!TRANSITIONS[data.action]!.includes(r.status)) throw new Error(`Cannot ${data.action} a ${r.status} release.`);
      patch = data.action === "pause" ? { status: "paused" } : data.action === "resume" ? { status: "rolling" }
        : data.action === "complete" ? { status: "complete", rollout_percent: 100 } : { status: "rolled_back", rollout_percent: 0, rollback_reason: "Manual rollback by owner." };
    }
    const { error: up } = await context.supabase.from("releases").update(patch).eq("id", r.id);
    if (up) throw new Error(up.message);
    await audit(context, `releases.${data.action}`, { release_id: r.id, version: r.version, channel: r.channel, ...patch });
    return { ok: true };
  });

export const deleteDraft = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("releases").delete().eq("id", data.id).eq("status", "draft");
    if (error) throw new Error(error.message);
    await audit(context, "releases.delete_draft", { release_id: data.id });
    return { ok: true };
  });

export const saveFlag = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ project_id: uuid, channel, key: z.string().trim().regex(/^[a-z0-9_.-]{1,64}$/, "Use lowercase letters, numbers, _ . -"), enabled: z.boolean(), rollout_percent: z.number().int().min(0).max(100), description: z.string().trim().max(300) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("feature_flags").upsert({ ...data, updated_at: new Date().toISOString() }, { onConflict: "project_id,channel,key" });
    if (error) throw new Error(error.message);
    await audit(context, "flags.save", data);
    return { ok: true };
  });

export const deleteFlag = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: uuid }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("feature_flags").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, "flags.delete", { id: data.id });
    return { ok: true };
  });
