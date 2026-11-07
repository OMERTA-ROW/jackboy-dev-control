import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function owner(ctx: { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can add projects to CODE.");
  return ctx.userId;
}
const pid = z.object({ projectId: z.string().uuid() });

/** Read-only checklist for one project. */
export const getCodeSite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => pid.parse(d))
  .handler(async ({ data, context }) => {
    await owner(context as never);
    return (await import("./code-onboarding.server")).siteStatus(data.projectId);
  });

/** Pin state for every linked project (database + saved setting only). */
export const listCodeSites = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    return (await import("./code-onboarding.server")).siteList();
  });

/** One button: approved files on jackboy/code-onboarding + a draft PR with exactly those files. No passkey: it only opens a draft PR. */
export const prepareCodeSite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => pid.parse(d))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const s = await import("./code-onboarding.server");
    const r = await s.prepareSite(data.projectId, actor);
    return { ...r, status: await s.siteStatus(data.projectId) };
  });

/** Fresh passkey only: re-checks every gate live, then pins the site to the exact workflow SHA. */
export const activateCodeSite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => pid.extend({ grantId: z.string().uuid(), workflowSha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(d))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    return (await import("./code-onboarding.server")).activateSite(data.projectId, actor, data.grantId, data.workflowSha);
  });

/** Fresh passkey only: takes a site off the allow list (history kept). */
export const removeCodeSite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => pid.extend({ grantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    return (await import("./code-onboarding.server")).removeSite(data.projectId, actor, data.grantId);
  });
