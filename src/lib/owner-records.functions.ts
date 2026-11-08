/**
 * Owner-scoped OMNI research handoffs and JAX draft manifests. Every query runs as the signed-in
 * user, so row security limits it to the owner's own rows. Nothing here sends anything to OMNI or
 * JAX, publishes, prices or sells — these are records of the owner's decisions.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { untyped } from "./untyped-db";
import {
  IMPORT_LIMIT, canPrepareJaxDraft, enforceApprovals, normalizeDeviceHandoff, normalizeDeviceManifest,
  normalizeProvenance, normalizeRevenue, planImport, rowToHandoff, type HandoffRow,
} from "./owner-records";
import { manifestFromHandoff, type ReleaseManifest } from "./jax";
import type { Handoff } from "./omni-handoff";

const HANDOFF_COLS = "id, owner_id, source_local_id, finding_id, title, sources, hypothesis, novelty_caveat, feasibility, requirements, risk, priority, est_cost, status, revenue, provenance, approvals, original, imported_at, archived_at, created_at, updated_at";
const MANIFEST_COLS = "id, source_local_id, handoff_id, name, version, simulated, manifest, imported_at, archived_at, created_at, updated_at";

async function log(userId: string, action: string, summary: string, status: "ok" | "info" | "warn" = "ok", detail?: Record<string, unknown>) {
  const { logSite } = await import("./site-log.server");
  await logSite({ actor: `owner:${userId}`, action, category: "approval", status, summary, detail });
}

export type SavedManifest = {
  id: string; fromDevice: boolean; sourceLocalId: string | null; handoffId: string | null; name: string; version: string;
  manifest: ReleaseManifest; importedAt: string | null; archivedAt: string | null; createdAt: string;
};

export const listOwnerRecords = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = untyped(context.supabase);
    const [h, m] = await Promise.all([
      db.from("omni_research_handoffs").select(HANDOFF_COLS).eq("owner_id", context.userId).order("created_at", { ascending: false }).limit(500),
      db.from("jax_release_manifests").select(MANIFEST_COLS).eq("owner_id", context.userId).order("created_at", { ascending: false }).limit(500),
    ]);
    if (h.error) throw new Error(`Could not read saved handoffs: ${h.error.message}`);
    if (m.error) throw new Error(`Could not read saved JAX drafts: ${m.error.message}`);
    const handoffRows = (h.data ?? []) as HandoffRow[];
    const manifestRows = (m.data ?? []) as Record<string, unknown>[];
    return {
      checkedAt: new Date().toISOString(),
      handoffs: handoffRows.map(rowToHandoff),
      handoffSourceIds: handoffRows.map((r) => r.source_local_id).filter((v): v is string => !!v),
      manifests: manifestRows.map((r): SavedManifest => ({
        id: String(r.id), fromDevice: r.source_local_id != null, sourceLocalId: (r.source_local_id as string) ?? null,
        handoffId: (r.handoff_id as string) ?? null, name: String(r.name), version: String(r.version),
        manifest: r.manifest as ReleaseManifest, importedAt: (r.imported_at as string) ?? null,
        archivedAt: (r.archived_at as string) ?? null, createdAt: String(r.created_at),
      })),
      manifestSourceIds: manifestRows.map((r) => r.source_local_id as string | null).filter((v): v is string => !!v),
    };
  });

/** One-press import of records saved only in this browser. Re-running it adds nothing twice
 * (unique per owner + original id); the browser copy is never changed or removed. */
export const importDeviceRecords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      handoffs: z.array(z.unknown()).max(IMPORT_LIMIT * 2).default([]),
      manifests: z.array(z.unknown()).max(IMPORT_LIMIT * 2).default([]),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const db = untyped(context.supabase);
    const owner = context.userId;
    const now = new Date().toISOString();
    const savedH = await db.from("omni_research_handoffs").select("id, source_local_id").eq("owner_id", owner).not("source_local_id", "is", null);
    if (savedH.error) throw new Error(`Could not read saved handoffs: ${savedH.error.message}`);
    const hPlan = planImport(data.handoffs, normalizeDeviceHandoff, (savedH.data ?? []).map((r) => r.source_local_id as string));
    let handoffsAdded = 0;
    if (hPlan.add.length) {
      const rows = hPlan.add.map(({ created_at, ...r }) => ({ ...r, owner_id: owner, imported_at: now, ...(created_at ? { created_at } : {}) }));
      const ins = await db.from("omni_research_handoffs").upsert(rows, { onConflict: "owner_id,source_local_id", ignoreDuplicates: true }).select("id");
      if (ins.error) throw new Error(`Could not save handoffs: ${ins.error.message}`);
      handoffsAdded = ins.data?.length ?? 0;
    }
    const idMap = await db.from("omni_research_handoffs").select("id, source_local_id").eq("owner_id", owner).not("source_local_id", "is", null);
    if (idMap.error) throw new Error(`Could not read saved handoffs: ${idMap.error.message}`);
    const handoffIdFor = new Map((idMap.data ?? []).map((r) => [r.source_local_id as string, r.id as string]));

    const savedM = await db.from("jax_release_manifests").select("source_local_id").eq("owner_id", owner).not("source_local_id", "is", null);
    if (savedM.error) throw new Error(`Could not read saved JAX drafts: ${savedM.error.message}`);
    const mPlan = planImport(data.manifests, normalizeDeviceManifest, (savedM.data ?? []).map((r) => r.source_local_id as string));
    let manifestsAdded = 0;
    if (mPlan.add.length) {
      const rows = mPlan.add.map(({ created_at, source_handoff_local_id, ...r }) => ({
        ...r, owner_id: owner, imported_at: now, simulated: true,
        handoff_id: source_handoff_local_id ? handoffIdFor.get(source_handoff_local_id) ?? null : null,
        ...(created_at ? { created_at } : {}),
      }));
      const ins = await db.from("jax_release_manifests").upsert(rows, { onConflict: "owner_id,source_local_id", ignoreDuplicates: true }).select("id");
      if (ins.error) throw new Error(`Could not save JAX drafts: ${ins.error.message}`);
      manifestsAdded = ins.data?.length ?? 0;
    }
    const result = {
      handoffs: { added: handoffsAdded, alreadySaved: hPlan.alreadySaved + (hPlan.add.length - handoffsAdded), invalid: hPlan.invalid },
      manifests: { added: manifestsAdded, alreadySaved: mPlan.alreadySaved + (mPlan.add.length - manifestsAdded), invalid: mPlan.invalid },
    };
    await log(owner, "records.device_import", `Imported ${handoffsAdded} OMNI handoff(s) and ${manifestsAdded} JAX draft(s) from this browser; ${result.handoffs.alreadySaved + result.manifests.alreadySaved} already saved, ${hPlan.invalid.length + mPlan.invalid.length} unreadable. Browser copy left unchanged.`,
      hPlan.invalid.length + mPlan.invalid.length ? "warn" : "ok", { invalid: [...hPlan.invalid, ...mPlan.invalid].slice(0, 20) });
    return result;
  });

const revenueSchema = z.record(z.string(), z.record(z.string(), z.number().min(0).max(1e12)));
const patchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["draft", "pending", "approved", "rejected"]).optional(),
  provenance: z.object({
    ownershipConfirmed: z.boolean(), ossReviewed: z.boolean(), noScrapedOrUnlicensed: z.boolean(), notes: z.string().max(4000),
  }).optional(),
  approval: z.object({ action: z.enum(["publish", "pricing", "deploy", "sell"]), value: z.boolean() }).optional(),
  revenue: revenueSchema.optional(),
});

export type HandoffPatchInput = Omit<z.infer<typeof patchSchema>, "id">;

/** Saves one owner decision on a handoff and returns the stored result (approval rules applied by the database). */
export const updateResearchHandoff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => patchSchema.parse(input))
  .handler(async ({ data, context }) => {
    const db = untyped(context.supabase);
    const cur = await db.from("omni_research_handoffs").select(HANDOFF_COLS).eq("id", data.id).eq("owner_id", context.userId).maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    if (!cur.data) throw new Error("This handoff is not in your account.");
    const before = rowToHandoff(cur.data as HandoffRow);
    if (before.archivedAt) throw new Error("This handoff is archived. Restore it before changing it.");
    const status: Handoff["status"] = data.status ?? before.status;
    const provenance = data.provenance ? normalizeProvenance(data.provenance) : before.provenance;
    const wanted = { ...before.approvals, ...(data.approval ? { [data.approval.action]: data.approval.value } : {}) };
    const approvals = enforceApprovals(status, provenance, status === "approved" ? wanted : {});
    if (data.approval && approvals[data.approval.action] !== data.approval.value)
      throw new Error(`"${data.approval.action}" is locked: approve the handoff${data.approval.action === "deploy" ? "" : " and tick all three provenance boxes"} first.`);
    const patch: Record<string, unknown> = { status, provenance, approvals };
    if (data.revenue) patch.revenue = normalizeRevenue(data.revenue);
    const up = await db.from("omni_research_handoffs").update(patch).eq("id", data.id).eq("owner_id", context.userId).select(HANDOFF_COLS).single();
    if (up.error) throw new Error(`Could not save: ${up.error.message}`);
    const after = rowToHandoff(up.data as HandoffRow);
    const changes: string[] = [];
    if (after.status !== before.status) changes.push(`status ${before.status} → ${after.status}`);
    for (const k of ["ownershipConfirmed", "ossReviewed", "noScrapedOrUnlicensed"] as const)
      if (after.provenance[k] !== before.provenance[k]) changes.push(`${k} ${after.provenance[k]}`);
    for (const k of Object.keys(after.approvals) as (keyof typeof after.approvals)[])
      if (after.approvals[k] !== before.approvals[k]) changes.push(`${k} ${after.approvals[k] ? "approved" : "not approved"}`);
    if (data.revenue) changes.push("monetization estimates saved");
    if (data.provenance && after.provenance.notes !== before.provenance.notes) changes.push("provenance notes saved");
    if (changes.length) await log(context.userId, "omni.research_handoff_updated", `"${after.title}": ${changes.join(", ")}.`);
    return after;
  });

export const setResearchHandoffArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), archived: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const db = untyped(context.supabase);
    const up = await db.from("omni_research_handoffs").update({ archived_at: data.archived ? new Date().toISOString() : null })
      .eq("id", data.id).eq("owner_id", context.userId).select("id, title").maybeSingle();
    if (up.error) throw new Error(up.error.message);
    if (!up.data) throw new Error("This handoff is not in your account.");
    await log(context.userId, data.archived ? "omni.research_handoff_archived" : "omni.research_handoff_restored", `${data.archived ? "Archived" : "Restored"} handoff "${up.data.title}" (kept, not deleted).`);
    return { ok: true };
  });

/** Records a JAX draft manifest from an approved, provenance-cleared handoff. Always simulated: JAX is not connected. */
export const createJaxDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ handoffId: z.string().uuid(), version: z.string().trim().regex(/^[0-9A-Za-z.+-]{1,40}$/) }).parse(input))
  .handler(async ({ data, context }) => {
    const db = untyped(context.supabase);
    const cur = await db.from("omni_research_handoffs").select(HANDOFF_COLS).eq("id", data.handoffId).eq("owner_id", context.userId).maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    if (!cur.data) throw new Error("This handoff is not in your account.");
    const h = rowToHandoff(cur.data as HandoffRow);
    if (h.archivedAt) throw new Error("This handoff is archived.");
    if (!canPrepareJaxDraft(h)) throw new Error("Approve the handoff and tick all three provenance boxes first.");
    const manifest = manifestFromHandoff(h, data.version, `owner:${context.userId}`);
    const ins = await db.from("jax_release_manifests").insert({
      owner_id: context.userId, handoff_id: h.id, name: manifest.name.slice(0, 300), version: data.version, simulated: true, manifest,
    }).select("id").single();
    if (ins.error) throw new Error(`Could not save the JAX draft: ${ins.error.message}`);
    await log(context.userId, "jax.draft_manifest_created", `Saved JAX draft manifest "${h.title}" v${data.version} (simulated; nothing sent — JAX not connected).`);
    return { id: ins.data.id as string };
  });

export const setJaxDraftArchived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), archived: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const db = untyped(context.supabase);
    const up = await db.from("jax_release_manifests").update({ archived_at: data.archived ? new Date().toISOString() : null })
      .eq("id", data.id).eq("owner_id", context.userId).select("id, name, version").maybeSingle();
    if (up.error) throw new Error(up.error.message);
    if (!up.data) throw new Error("This JAX draft is not in your account.");
    await log(context.userId, data.archived ? "jax.draft_archived" : "jax.draft_restored", `${data.archived ? "Archived" : "Restored"} JAX draft "${up.data.name}" v${up.data.version} (kept, not deleted).`);
    return { ok: true };
  });

/** Records a new pending handoff from a Discovery finding (owner review required; nothing is sent). */
export const createResearchHandoff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    findingId: z.string().max(200), title: z.string().trim().min(1).max(300), sources: z.array(z.string().max(1000)).max(50),
    hypothesis: z.string().max(8000), noveltyCaveat: z.string().max(4000), feasibility: z.number().min(0).max(5),
    requirements: z.string().max(20000), risk: z.enum(["low", "medium", "high"]), priority: z.enum(["low", "medium", "high"]),
    estCost: z.number().min(0).max(1e12),
  }).parse(input))
  .handler(async ({ data, context }) => {
    const db = untyped(context.supabase);
    const ins = await db.from("omni_research_handoffs").insert({
      owner_id: context.userId, finding_id: data.findingId, title: data.title, sources: data.sources, hypothesis: data.hypothesis,
      novelty_caveat: data.noveltyCaveat, feasibility: data.feasibility, requirements: data.requirements, risk: data.risk,
      priority: data.priority, est_cost: data.estCost, status: "pending",
    }).select("id").single();
    if (ins.error) throw new Error(`Could not save the handoff: ${ins.error.message}`);
    await log(context.userId, "omni.research_handoff_created", `Queued "${data.title}" for owner review (not sent to OMNI).`, "info");
    return { id: ins.data.id as string };
  });
