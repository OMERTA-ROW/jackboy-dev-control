import { describe, expect, it, vi } from "vitest";
import {
  CODE_PER_CALL_MAX_USD,
  GatewayError,
  createCodeGateway,
  parsePerCallCap,
  parsePriceTable,
  prepareRequest,
  type GatewayDeps,
} from "./code-gateway";

// Owner rule: a single CODE AI call may reserve at most $0.50, whatever the setting says.

// Worst-case ceiling = maxInputTokens * input + maxOutputTokens * output (per million tokens).
// 100,000 * $4 + 25,000 * $4 = $0.40 + $0.10 = exactly $0.50.
const exact = parsePriceTable(
  JSON.stringify({
    "m-edge": {
      inputPerMillionUsd: 4,
      outputPerMillionUsd: 4,
      maxInputTokens: 100_000,
      maxOutputTokens: 25_000,
    },
  }),
);
// One more output token: $0.500004, just over the limit.
const over = parsePriceTable(
  JSON.stringify({
    "m-edge": {
      inputPerMillionUsd: 4,
      outputPerMillionUsd: 4,
      maxInputTokens: 100_000,
      maxOutputTokens: 25_001,
    },
  }),
);
const body = JSON.stringify({ model: "m-edge", input: "hi" });

describe("CODE per-call limit is $0.50", () => {
  it("the hard limit constant is $0.50", () => {
    expect(CODE_PER_CALL_MAX_USD).toBe(0.5);
  });

  it("accepts a configured cap up to and including $0.50", () => {
    expect(parsePerCallCap("0.5")).toBe(0.5);
    expect(parsePerCallCap("0.50")).toBe(0.5);
    expect(parsePerCallCap("0.25")).toBe(0.25);
  });

  it("refuses a configured cap above $0.50, including the old $1 and $5 values", () => {
    for (const raw of ["0.500001", "0.51", "1", "5"]) expect(parsePerCallCap(raw)).toBeNull();
  });

  it("fails closed on missing or malformed settings", () => {
    for (const raw of [undefined, "", "  ", "abc", "0", "-0.1", "NaN", "Infinity"]) {
      expect(parsePerCallCap(raw)).toBeNull();
    }
  });

  it("admits a call whose worst case is exactly $0.50", () => {
    expect(prepareRequest("/responses", body, exact, 0.5).ceilingUsd).toBe(0.5);
  });

  it("refuses a call whose worst case is just over $0.50", () => {
    expect(() => prepareRequest("/responses", body, over, 0.5)).toThrow(/per-call spending ceiling/);
  });

  it("refuses a cap above $0.50 even when the call itself is cheap", () => {
    try {
      prepareRequest("/responses", body, exact, 1);
      throw new Error("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).status).toBe(503);
    }
  });

  it("a gateway configured above $0.50 reserves nothing and never calls the provider", async () => {
    const admit = vi.fn(async () => "call1");
    const upstream = vi.fn(async () => Response.json({}));
    const deps: GatewayDeps = {
      authenticate: async () => ({ requestId: "r1", runId: 7 }),
      admit,
      dispatch: async () => undefined,
      abort: async () => undefined,
      settle: async () => undefined,
      markUnknown: async () => undefined,
      isStopped: async () => false,
      providerKey: () => "sk-test-key",
      prices: () => exact,
      perCallCapUsd: () => 1,
      upstream,
      newKey: () => "k".repeat(16),
    };
    const response = await createCodeGateway(deps)(
      new Request("https://x.test/api/public/code/provider/v1/responses", { method: "POST", body }),
    );
    expect(response.status).toBe(503);
    expect(admit).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
});
