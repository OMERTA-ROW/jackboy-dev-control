import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Context = {
  supabase: { rpc: (fn: "my_role") => PromiseLike<{ data: unknown }> };
  userId: string;
};

async function requireOwner(context: Context) {
  const { data } = await context.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can manage deployments.");
}

export const getLovableDeploymentDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    return (await import("./lovable-deployment.server")).getDeploymentDashboard();
  });

export const publishLovableProduction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z
      .object({
        projectId: z
          .string()
          .regex(
            /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|prj_[A-Za-z0-9]{12,64})$/i,
          ),
        commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
        grantId: z.string().uuid(),
      })
      .parse(value),
  )
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    return (await import("./lovable-deployment.server")).publishLovableProject({
      ...data,
      actor: context.userId,
    });
  });

export const getLovableDeploymentStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z
      .object({
        projectId: z
          .string()
          .regex(
            /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|prj_[A-Za-z0-9]{12,64})$/i,
          ),
        deploymentId: z
          .string()
          .min(8)
          .max(100)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .parse(value),
  )
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    return (await import("./lovable-deployment.server")).getLovableDeploymentStatus(
      data.projectId,
      data.deploymentId,
      context.userId,
    );
  });

export const requestLovableRollback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z.object({ projectId: z.string().min(8).max(100) }).parse(value),
  )
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    return (await import("./lovable-deployment.server")).logLovableRollbackRequest(
      data.projectId,
      context.userId,
    );
  });
