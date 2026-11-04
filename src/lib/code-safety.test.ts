import { describe, expect, it } from "vitest";
import {
  CODE_DAILY_SPEND_LIMIT_USD,
  CODE_MAX_CONSECUTIVE_FAILURES,
  classifyGithubCancellationState,
  codeStartBlockReason,
  nextConsecutiveFailures,
  parseCodeTargets,
  shouldPauseForSpend,
  type CodeSafetyState,
} from "./code-safety";
import { parseOpenAICostPage } from "./openai-costs";

const now = Date.parse("2026-11-03T18:00:00Z");
const repo = "OMERTA-ROW/jackboy-dev-control";
const state = (overrides: Partial<CodeSafetyState> = {}): CodeSafetyState => ({
  enabled: true,
  killSwitch: false,
  allowedTargets: { [repo]: { ref: "main", workflowSha: "a".repeat(40) } },
  activeRequestId: null,
  consecutiveFailures: 0,
  dailySpendLimitUsd: CODE_DAILY_SPEND_LIMIT_USD,
  providerSpendTodayUsd: 1.25,
  providerUsageAt: new Date(now - 1000).toISOString(),
  providerBudgetEnforced: true,
  reservedHoldsUsd: 0,
  perTaskReserveUsd: 1,
  usageSpike: false,
  ...overrides,
});

describe("CODE runtime safety policy", () => {
  it("accepts exact repository allowlists and rejects malformed targets", () => {
    expect(parseCodeTargets({ [repo]: { ref: "main", workflowSha: "a".repeat(40) } })).toEqual({
      [repo]: { ref: "main", workflowSha: "a".repeat(40) },
    });
    expect(() => parseCodeTargets({ "*": { ref: "main", workflowSha: "a".repeat(40) } })).toThrow();
    expect(() => parseCodeTargets({ [repo]: { ref: "main", workflowSha: "bad" } })).toThrow();
    expect(() => parseCodeTargets([])).toThrow();
  });

  it("blocks unauthorized repositories, concurrent work, kill switch and disabled mode", () => {
    expect(codeStartBlockReason(state(), "OMERTA-ROW/other", now)).toMatch(/allowlist/);
    expect(codeStartBlockReason(state({ activeRequestId: "active" }), repo, now)).toMatch(
      /already active/,
    );
    expect(codeStartBlockReason(state({ killSwitch: true }), repo, now)).toMatch(/kill switch/);
    expect(codeStartBlockReason(state({ enabled: false }), repo, now)).toMatch(/disabled/);
  });

  it("shuts down after two consecutive failures and resets only on success", () => {
    expect(nextConsecutiveFailures(0, "failure")).toBe(1);
    expect(nextConsecutiveFailures(1, "failure")).toBe(CODE_MAX_CONSECUTIVE_FAILURES);
    expect(nextConsecutiveFailures(2, "success")).toBe(0);
    expect(codeStartBlockReason(state({ consecutiveFailures: 2 }), repo, now)).toMatch(
      /two consecutive/,
    );
  });

  it("fails closed without authoritative fresh metering or provider budget enforcement", () => {
    expect(codeStartBlockReason(state({ providerSpendTodayUsd: null }), repo, now)).toMatch(
      /authoritative/,
    );
    expect(codeStartBlockReason(state({ providerBudgetEnforced: false }), repo, now)).toMatch(
      /authoritative/,
    );
    expect(codeStartBlockReason(state({ providerUsageAt: null }), repo, now)).toMatch(
      /authoritative/,
    );
    expect(
      codeStartBlockReason(
        state({ providerUsageAt: new Date(now - 6 * 60_000).toISOString() }),
        repo,
        now,
      ),
    ).toMatch(/stale/);
    expect(codeStartBlockReason(state({ providerSpendTodayUsd: 5 }), repo, now)).toMatch(/limit/);
    expect(codeStartBlockReason(state({ dailySpendLimitUsd: 5.01 }), repo, now)).toMatch(/invalid/);
  });

  it("requires the worst-case reservation to fit after outstanding holds, and fails closed without hold data", () => {
    expect(codeStartBlockReason(state({ providerSpendTodayUsd: 3, reservedHoldsUsd: 1 }), repo, now)).toBeNull();
    expect(codeStartBlockReason(state({ providerSpendTodayUsd: 3, reservedHoldsUsd: 1.01 }), repo, now)).toMatch(/reservation/);
    expect(codeStartBlockReason(state({ providerSpendTodayUsd: 4.5 }), repo, now)).toMatch(/reservation/);
    for (const overrides of [
      { reservedHoldsUsd: null },
      { perTaskReserveUsd: null },
      { reservedHoldsUsd: -1 },
      { reservedHoldsUsd: Number.NaN },
      { perTaskReserveUsd: 0 },
      { perTaskReserveUsd: 5.01 },
    ]) {
      expect(codeStartBlockReason(state(overrides), repo, now)).toMatch(/reservation data is unavailable/);
    }
  });

  it("pauses after a usage spike or cap is reached", () => {
    expect(shouldPauseForSpend(2.5, 2.5, 5)).toBe(true);
    expect(shouldPauseForSpend(2.49, 0.5, 5)).toBe(false);
    expect(() => shouldPauseForSpend(Number.NaN, 0, 5)).toThrow();
    expect(codeStartBlockReason(state({ usageSpike: true }), repo, now)).toMatch(/spike/);
  });

  it("reconciles cancellation only after GitHub confirms the run is cancelled", () => {
    expect(classifyGithubCancellationState("in_progress", null)).toBe("active");
    expect(classifyGithubCancellationState("completed", "cancelled")).toBe("confirmed");
    expect(classifyGithubCancellationState("completed", "success")).toBe("completed");
    expect(classifyGithubCancellationState("queued", null)).toBe("active");
    expect(classifyGithubCancellationState("unknown", null)).toBe("unverified");
  });

  it("accepts only validated USD cost buckets and produces stable idempotency keys", () => {
    const response = {
      object: "page",
      has_more: false,
      next_page: null,
      data: [
        {
          object: "bucket",
          start_time: Date.parse("2026-11-03T00:00:00Z") / 1000,
          end_time: Date.parse("2026-11-04T00:00:00Z") / 1000,
          results: [
            {
              object: "organization.costs.result",
              amount: { value: 0.25, currency: "usd" },
              line_item: "model input",
              project_id: "proj_code",
              api_key_id: "key_code",
            },
          ],
        },
      ],
    };
    const parsed = parseOpenAICostPage(response, "proj_code", "key_code");
    const bucket = response.data[0];
    if (!bucket) throw new Error("Expected test cost bucket.");
    const costResult = bucket.results[0];
    if (!costResult) throw new Error("Expected test cost result.");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      source: "openai_org_costs",
      cost_usd: 0.25,
      request_id: null,
    });
    expect(parseOpenAICostPage(response, "proj_code", "key_code").rows[0]?.provider_event_id).toBe(
      parsed.rows[0]?.provider_event_id,
    );
    expect(
      parseOpenAICostPage(
        { ...response, has_more: true, next_page: "next-cursor" },
        "proj_code",
        "key_code",
      ),
    ).toMatchObject({ hasMore: true, nextPage: "next-cursor" });
    expect(() =>
      parseOpenAICostPage(
        {
          ...response,
          data: [
            {
              ...bucket,
              results: [
                {
                  ...costResult,
                  amount: { value: 0.25, currency: "credits" },
                },
              ],
            },
          ],
        },
        "proj_code",
        "key_code",
      ),
    ).toThrow(/unsupported or invalid amount/);
    expect(() =>
      parseOpenAICostPage(
        {
          ...response,
          data: [
            {
              ...bucket,
              results: [{ ...costResult, project_id: "proj_other" }],
            },
          ],
        },
        "proj_code",
        "key_code",
      ),
    ).toThrow(/unsupported or invalid amount/);
  });
});


describe("admission meter edge cases", () => {
  it("rejects negative, non-finite, future and previous-day measurements", () => {
    for (const spend of [-1, NaN, Infinity]) {
      expect(codeStartBlockReason(state({ providerSpendTodayUsd: spend }), repo, now)).toBeTruthy();
    }
    for (const timestamp of ["invalid", new Date(now + 31_000).toISOString()]) {
      expect(codeStartBlockReason(state({ providerUsageAt: timestamp }), repo, now)).toBeTruthy();
    }
    const midnight = Date.parse("2026-11-04T00:00:01Z");
    expect(codeStartBlockReason(state({ providerUsageAt: "2026-11-03T23:59:59Z" }), repo, midnight)).toMatch(/stale/);
  });
  it("rejects duplicate entries even in the final cost bucket", () => {
    const result = { object: "organization.costs.result", amount: { value: 1, currency: "usd" }, project_id: "p", api_key_id: "k", line_item: "input" };
    const page = { has_more: false, data: [{ object: "bucket", start_time: 1, end_time: 2, results: [result, result] }] };
    expect(() => parseOpenAICostPage(page, "p", "k")).toThrow(/duplicate/);
    expect(() => parseOpenAICostPage({ ...page, data: [{ ...page.data[0], results: [result] }] }, "other", "k")).toThrow();
  });
});
