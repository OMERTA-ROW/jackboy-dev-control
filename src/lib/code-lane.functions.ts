import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function owner(ctx: { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can manage CODE approval lanes.");
  return ctx.userId;
}

/** Read-only: automatic environments per CODE site, switch state, pinned workflow readiness and the trial log. */
export const getCodeLaneStatus = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    return (await import("./code-lane.server")).laneStatus();
  });

/** Fresh passkey: turn the automatic lane on or off for one site. */
export const setCodeAutoLane = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), on: z.boolean(), grantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => (await import("./code-lane.server")).setAutoLane(await owner(context as never), data.repo, data.on, data.grantId));
