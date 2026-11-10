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

type ListReader = {
  from: (table: "omni_dispatch_v3_jobs") => {
    select: (cols: string) => {
      order: (col: string, opts: { ascending: boolean }) => {
        limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
};

/** Most recent scoped v3 jobs with their stored status/result, newest first. */
export async function listOmniV3Jobs(client: unknown, limit = 10) {
  const { data, error } = await (client as ListReader)
    .from("omni_dispatch_v3_jobs")
    .select("job_id,status,result,result_at,updated_at,last_source,repo")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Stored OMNI job statuses could not be read.");
  return ((data ?? []) as (NonNullable<V3JobRecord> & { repo: string; job_id: string })[]).map(
    (row) => ({
      ok: true as const,
      jobId: row.job_id,
      repo: row.repo,
      updatedAt: row.updated_at,
      resultAt: row.result_at,
      source: row.last_source,
      ...describeV3Job(row),
    }),
  );
}

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
