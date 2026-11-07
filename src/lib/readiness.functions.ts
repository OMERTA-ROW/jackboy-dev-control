import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { READINESS } from "./readiness";

async function requireOwner(ctx: { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> } }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can see activation readiness.");
}

const SERVER_TESTED = READINESS.filter((r) => r.test !== "passkey" && r.id !== "provider_gateway").map((r) => r.id) as [string, ...string[]];

/** Owner-only, read-only: live observations of real use plus the newest recorded Tests. */
export const getReadiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    return (await import("./readiness.server")).observeReadiness();
  });

/** Owner-only, read-only probe of one item. Its result is appended to the site log; nothing is turned on or off. */
export const testReadiness = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ item: z.enum(SERVER_TESTED) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    const { runReadinessTest } = await import("./readiness.server");
    return runReadinessTest(data.item as never, context.userId);
  });
