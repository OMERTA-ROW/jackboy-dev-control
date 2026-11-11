import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { redact } from "./site-log";

function safeText(value: string) {
  const withoutSensitiveLines = value
    .split(/\r?\n/)
    .map((line) =>
      /\b(?:secret|token|password|credential|authorization|signature|hmac|nonce|payload[_ -]?digest|private[_ -]?key)\b/i.test(
        line,
      )
        ? "[sensitive line redacted]"
        : line.replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]"),
    )
    .join("\n");
  return Array.from(redact(withoutSensitiveLines)).slice(0, 500).join("");
}

function resultSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const countsValue = result["test_counts"] ?? result["tests"];
  const counts =
    countsValue && typeof countsValue === "object" && !Array.isArray(countsValue)
      ? (countsValue as Record<string, unknown>)
      : {};
  const count = (key: string) =>
    typeof counts[key] === "number" && Number.isSafeInteger(counts[key]) && counts[key] >= 0
      ? (counts[key] as number)
      : null;
  return {
    passed: typeof result["passed"] === "boolean" ? result["passed"] : null,
    testCounts: { passed: count("passed"), failed: count("failed"), total: count("total") },
    summary: typeof result["summary"] === "string" ? safeText(result["summary"]) : null,
    log:
      typeof result["output"] === "string"
        ? safeText(result["output"])
        : typeof result["log"] === "string"
          ? safeText(result["log"])
          : null,
  };
}

export const getOmniV3Results = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const role = await context.supabase.rpc("my_role");
    if (role.error || role.data !== "owner")
      throw new Error("Only the owner can view OMNI results.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("omni_dispatch_v3_jobs")
      .select("job_id,kind,repo,status,created_at,updated_at,expires_at,result")
      .eq("owner_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error("OMNI results could not be loaded.");
    return (data ?? []).map((row) => ({
      jobId: row.job_id,
      kind: row.kind,
      repo: row.repo,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      result: resultSummary(row.result),
    }));
  });
