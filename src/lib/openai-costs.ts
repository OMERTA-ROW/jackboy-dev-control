import { createHash } from "node:crypto";

export type OpenAICostRow = {
  provider_event_id: string;
  source: "openai_org_costs";
  occurred_at: string;
  cost_usd: number;
  request_id: null;
};

type CostResult = {
  object?: unknown;
  amount?: { value?: unknown; currency?: unknown };
  line_item?: unknown;
  project_id?: unknown;
  api_key_id?: unknown;
};

type CostBucket = {
  object?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  results?: unknown;
};

export function parseOpenAICostPage(
  value: unknown,
  projectId: string,
  apiKeyId: string,
): { rows: OpenAICostRow[]; hasMore: boolean; nextPage: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI costs response is invalid.");
  }
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page["data"]) || typeof page["has_more"] !== "boolean") {
    throw new Error("OpenAI costs response is incomplete.");
  }
  const rows: OpenAICostRow[] = [];
  for (const rawBucket of page["data"]) {
    if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) {
      throw new Error("OpenAI costs response contains an invalid bucket.");
    }
    const bucket = rawBucket as CostBucket;
    if (
      bucket.object !== "bucket" ||
      typeof bucket.start_time !== "number" ||
      typeof bucket.end_time !== "number" ||
      !Number.isInteger(bucket.start_time) ||
      !Number.isInteger(bucket.end_time) ||
      Number(bucket.end_time) <= Number(bucket.start_time) ||
      !Array.isArray(bucket.results)
    ) {
      throw new Error("OpenAI costs response contains an invalid bucket.");
    }
    if (new Set(rows.map((row) => row.provider_event_id)).size !== rows.length) {
      throw new Error("OpenAI costs response contains duplicate bucket entries.");
    }
    for (const rawResult of bucket.results) {
      if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
        throw new Error("OpenAI costs response contains an invalid cost entry.");
      }
      const result = rawResult as CostResult;
      const amount = result.amount;
      if (
        result.object !== "organization.costs.result" ||
        result.project_id !== projectId ||
        result.api_key_id !== apiKeyId ||
        !amount ||
        typeof amount.value !== "number" ||
        !Number.isFinite(amount.value) ||
        amount.value < 0 ||
        amount.currency !== "usd" ||
        (result.line_item !== null &&
          result.line_item !== undefined &&
          typeof result.line_item !== "string")
      ) {
        throw new Error("OpenAI costs response contains an unsupported or invalid amount.");
      }
      const lineItem = result.line_item ?? "unattributed";
      const providerEventId = createHash("sha256")
        .update(
          [
            "openai-org-costs-v1",
            projectId,
            apiKeyId,
            String(bucket.start_time),
            String(bucket.end_time),
            lineItem,
          ].join("\n"),
        )
        .digest("hex");
      rows.push({
        provider_event_id: providerEventId,
        source: "openai_org_costs",
        occurred_at: new Date(Number(bucket.start_time) * 1000).toISOString(),
        cost_usd: amount.value,
        request_id: null,
      });
    }
  }
  const nextPage = page["next_page"];
  if (page["has_more"] && (typeof nextPage !== "string" || nextPage.length === 0)) {
    throw new Error("OpenAI costs pagination is incomplete.");
  }
  return {
    rows,
    hasMore: page["has_more"],
    nextPage: typeof nextPage === "string" ? nextPage : null,
  };
}
