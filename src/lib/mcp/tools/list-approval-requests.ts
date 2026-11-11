import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";
import { clip, failIfError } from "../util";

export default defineTool({
  name: "list_approval_requests",
  title: "List approval requests",
  description: "List recent approval requests (owner only) and their decisions. Read-only: approving still requires the owner's passkey in Jackboy.",
  inputSchema: {
    status: z.string().trim().min(1).max(30).optional().describe("Only requests with this status, e.g. pending, allowed, denied or expired."),
    limit: z.number().int().min(1).max(50).optional().describe("How many requests to return (default 20)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ status, limit }, ctx) => {
    let q = supabaseForUser(ctx)
      .from("action_requests")
      .select("id, action, tier, risk, status, diff_summary, created_at, expires_at, decided_at")
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    failIfError(error, "approval requests");
    const requests = (data ?? []).map((r) => ({
      id: r.id, action: r.action, tier: r.tier, risk: r.risk, status: r.status, summary: clip(r.diff_summary, 200), createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at,
    }));
    const text = requests.length === 0 ? "No approval requests found."
      : requests.map((r) => `${r.id}: ${r.action} — ${r.status} (risk ${r.risk ?? "?"}, created ${r.createdAt})`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { requests } };
  },
});
