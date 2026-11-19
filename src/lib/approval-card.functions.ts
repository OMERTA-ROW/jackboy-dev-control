// Owner-only, read-only server function behind approval-card deep links. See approval-card.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getApprovalCard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().max(64) }).parse(d))
  .handler(async ({ data, context }) => {
    const { loadApprovalCard } = await import("./approval-card.server");
    return loadApprovalCard(context.supabase as never, context.userId, data.id, {
      codeCard: async (id, userId) => (await import("./code.server")).getCode(id, userId, { readOnly: true }),
    });
  });
