// Server-only OpenAI organization cost report reader (free admin endpoint, not a model call).
import { parseOpenAICostPage, type OpenAICostRow } from "./openai-costs";

export type CostReportSettings = { adminKey: string; projectId: string; apiKeyId: string };

/** Reads the three cost-report settings by name; null when any is missing or malformed. */
export function costReportSettings(): CostReportSettings | null {
  const adminKey = process.env["OPENAI_ADMIN_KEY"];
  const projectId = process.env["OPENAI_CODE_PROJECT_ID"];
  const apiKeyId = process.env["OPENAI_CODE_API_KEY_ID"];
  if (!adminKey || !projectId || !apiKeyId || projectId.length > 200 || apiKeyId.length > 200) return null;
  return { adminKey, projectId, apiKeyId };
}

/** Daily cost buckets for the CODE project + key between start and end (UTC seconds). */
export async function fetchOpenAICostRows(settings: CostReportSettings, start: Date, end: Date): Promise<OpenAICostRow[]> {
  const params = new URLSearchParams({
    start_time: String(Math.floor(start.getTime() / 1000)),
    end_time: String(Math.floor(end.getTime() / 1000)),
    bucket_width: "1d",
    limit: "180",
  });
  params.append("project_ids", settings.projectId);
  params.append("api_key_ids", settings.apiKeyId);
  params.append("group_by", "project_id");
  params.append("group_by", "api_key_id");
  params.append("group_by", "line_item");
  const headers = new Headers({ Accept: "application/json" });
  headers.set("Authorization", `Bearer ${settings.adminKey}`);
  const rows: OpenAICostRow[] = [];
  const pages = new Set<string>();
  let page: string | null = null;
  for (let count = 0; count < 10; count++) {
    if (page) {
      if (pages.has(page)) throw new Error("OpenAI costs pagination repeated a cursor.");
      pages.add(page);
      params.set("page", page);
    }
    const response = await fetch(`https://api.openai.com/v1/organization/costs?${params}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) throw new Error("OpenAI cost sync credential was rejected (HTTP 401).");
    if (response.status === 403) throw new Error("OpenAI cost sync credential lacks organization usage permission (HTTP 403).");
    if (!response.ok) throw new Error(`OpenAI cost sync failed (HTTP ${response.status}).`);
    const parsed = parseOpenAICostPage(await response.json(), settings.projectId, settings.apiKeyId);
    rows.push(...parsed.rows);
    if (!parsed.hasMore) break;
    page = parsed.nextPage;
    if (count === 9) throw new Error("OpenAI costs pagination exceeded the safety limit.");
  }
  return rows;
}
