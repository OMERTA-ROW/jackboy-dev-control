// Owner-scoped read of the stored v3 dispatch status/result. Uses the caller's RLS client, so only
// the owner sees rows. Reports exactly what was stored; never fills in a missing result.
import { describeV3Job, type V3JobRecord } from "./omni-dispatch-v3";

type Reader = {
  from: (table: "omni_dispatch_v3_jobs") => {
    select: (cols: string) => {
      eq: (col: string, value: string) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
};

export async function readOmniV3Job(client: unknown, jobId: string) {
  const db = client as Reader;
  const { data, error } = await db
    .from("omni_dispatch_v3_jobs")
    .select("job_id,status,result,result_at,updated_at,last_source,repo")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) return { ok: false as const, jobId, error: "The stored OMNI status could not be read." };
  const row = (data ?? null) as (NonNullable<V3JobRecord> & { repo: string }) | null;
  return {
    ok: true as const,
    jobId,
    repo: row?.repo ?? null,
    updatedAt: row?.updated_at ?? null,
    resultAt: row?.result_at ?? null,
    source: row?.last_source ?? null,
    ...describeV3Job(row),
  };
}
