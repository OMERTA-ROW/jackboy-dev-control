// Owner-only view of the three OMNI link values Railway must copy from Jackboy.
// Status is read-only and value-free; the reveal needs a fresh passkey every time and is logged
// (without the values). Nothing here changes settings, runs the self-test or enables the link.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { approvalSaveProblem, REVEAL_ACTION, REVEAL_TARGET, summarizeLinkValues } from "./omni-link-values";
import { saveErrorText, withApproval, type EffectiveApproval } from "./omni-link-approval";

type Ctx = {
  userId: string;
  supabase: {
    rpc: (f: "my_role") => PromiseLike<{ data: unknown }>;
    auth: { getUser: () => Promise<{ error: unknown; data: { user: { id: string; email_confirmed_at?: string | null } | null } }> };
  };
};

async function requireConfirmedOwner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can see the OMNI link values.");
  const identity = await ctx.supabase.auth.getUser();
  if (identity.error || identity.data.user?.id !== ctx.userId || !identity.data.user.email_confirmed_at)
    throw new Error("A confirmed owner session is required.");
}

/** The three values with the effective approval (passkey-saved record over legacy settings). */
async function linkEnv() {
  const { loadEffectiveApproval } = await import("./omni-session.server");
  const approval = await loadEffectiveApproval();
  return {
    env: withApproval({ OMNI_LINK_OWNER_ID: process.env["OMNI_LINK_OWNER_ID"] } as Record<string, string | undefined>, approval),
    approval,
  };
}
const statusOf = (approval: EffectiveApproval) => ({ source: approval.source, savedAt: approval.savedAt });

/** Read-only, no values: which of the three are set, valid and matching, and where the approval comes from. */
export const getOmniLinkValueStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireConfirmedOwner(context as unknown as Ctx);
    const { env, approval } = await linkEnv();
    return {
      summary: summarizeLinkValues(env, context.userId),
      approval: statusOf(approval),
      linkEnabled: process.env["OMNI_LINK_ENABLED"] === "true",
    };
  });

/** Owner + fresh passkey (`omni_link_approval_save`): stores approval ID and expiry together in
 * Jackboy's single saved record. Never enables the link, never touches Railway or project access. */
export const saveOmniLinkApproval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ grantId: z.string().uuid(), approvalId: z.string().uuid(), expiresAt: z.string().datetime({ offset: true }) }).strict().parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireConfirmedOwner(context as unknown as Ctx);
    const problem = approvalSaveProblem(data.expiresAt);
    if (problem) throw new Error(`${problem} Nothing was saved.`);
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { error } = await db.rpc("save_omni_link_approval", {
      _actor: context.userId,
      _grant: data.grantId,
      _approval: data.approvalId.toLowerCase(),
      _expires: new Date(Date.parse(data.expiresAt)).toISOString(),
    });
    if (error) throw new Error(`${saveErrorText((error as { message?: string }).message)} Nothing was saved.`);
    const { env, approval } = await linkEnv();
    const summary = summarizeLinkValues(env, context.userId);
    if (approval.source !== "database" || approval.approvalId !== data.approvalId.toLowerCase())
      throw new Error("Saved, but Jackboy could not read it back. Press Recheck before copying anything to Railway.");
    return { summary, approval: statusOf(approval), linkEnabled: process.env["OMNI_LINK_ENABLED"] === "true" };
  });

/** Owner + fresh passkey (`omni_link_values`): returns the three values to copy into Railway. */
export const revealOmniLinkValues = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ grantId: z.string().uuid() }).strict().parse(input))
  .handler(async ({ context, data }) => {
    await requireConfirmedOwner(context as unknown as Ctx);
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, REVEAL_ACTION, REVEAL_TARGET, {
      requireFresh: true,
    });
    const { env, approval } = await linkEnv();
    const summary = summarizeLinkValues(env, context.userId);
    const { logSite } = await import("./site-log.server");
    await logSite({
      actor: context.userId,
      action: "omni_link.values_revealed",
      category: "config",
      status: "ok",
      summary: `Owner viewed the OMNI link values with a fresh passkey (values not logged; expiry ${summary.expiry}).`,
    });
    return {
      values: {
        OMNI_LINK_OWNER_ID: env["OMNI_LINK_OWNER_ID"]?.trim() || null,
        OMNI_LINK_APPROVAL_ID: env["OMNI_LINK_APPROVAL_ID"]?.trim() || null,
        OMNI_LINK_APPROVAL_EXPIRES_AT: env["OMNI_LINK_APPROVAL_EXPIRES_AT"]?.trim() || null,
      },
      yourOwnerId: context.userId,
      summary,
      approval: statusOf(approval),
    };
  });
