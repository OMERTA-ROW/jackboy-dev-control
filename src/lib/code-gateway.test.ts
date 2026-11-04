import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_STOP_POLL_MS,
  GatewayError,
  costUsd,
  createCodeGateway,
  extractUsage,
  parsePriceTable,
  prepareRequest,
  type GatewayDeps,
} from "./code-gateway";

const PRICES = JSON.stringify({
  "m-test": { inputPerMillionUsd: 1, outputPerMillionUsd: 4, maxOutputTokens: 1000 },
});
const prices = parsePriceTable(PRICES);
const body = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: "m-test", input: "hello", ...extra });

type Calls = string[];
function harness(over: Partial<GatewayDeps> = {}, upstream?: GatewayDeps["upstream"]) {
  const calls: Calls = [];
  const upstreamFn = vi.fn<GatewayDeps["upstream"]>(
    upstream ??
      (async () =>
        Response.json(
          { usage: { input_tokens: 10, output_tokens: 20 } },
          { headers: { "x-request-id": "req_1" } },
        )),
  );
  const deps: GatewayDeps = {
    authenticate: async () => ({ requestId: "r1", runId: 7 }),
    admit: async (_i, _k, _m, ceiling) => {
      calls.push(`admit:${ceiling}`);
      return "call1";
    },
    dispatch: async () => void calls.push("dispatch"),
    abort: async (_id, reason) => void calls.push(`abort:${reason}`),
    settle: async (_id, usd) => void calls.push(`settle:${usd}`),
    markUnknown: async (_id, reason) => void calls.push(`unknown:${reason}`),
    isStopped: async () => false,
    providerKey: () => "sk-test-key",
    prices: () => prices,
    perCallCapUsd: () => 1,
    upstream: upstreamFn,
    newKey: () => "k".repeat(16),
    ...over,
  };
  const handle = createCodeGateway(deps);
  const send = (path = "/responses", b = body(), method = "POST") =>
    handle(
      new Request(`https://x.test/api/public/code/provider/v1${path}`, {
        method,
        ...(method === "POST" ? { body: b } : {}),
      }),
    );
  return { calls, upstreamFn, send };
}

describe("pricing and ceilings", () => {
  it("fails closed on missing, malformed or empty price tables", () => {
    for (const raw of [
      undefined,
      "",
      "nope",
      "[]",
      "{}",
      '{"m":{"inputPerMillionUsd":0,"outputPerMillionUsd":1,"maxOutputTokens":1}}',
      '{"m":{"inputPerMillionUsd":1,"outputPerMillionUsd":1,"maxOutputTokens":1.5}}',
    ]) {
      expect(() => parsePriceTable(raw)).toThrow(GatewayError);
    }
  });
  it("rounds costs up and bounds input by body size and output by the clamp", () => {
    expect(costUsd(prices["m-test"]!, 1, 1)).toBeGreaterThan(0);
    const p = prepareRequest("/responses", body({ max_output_tokens: 5000 }), prices, 1);
    expect(JSON.parse(p.body).max_output_tokens).toBe(1000);
    expect(p.ceilingUsd).toBeGreaterThanOrEqual(
      costUsd(prices["m-test"]!, Buffer.byteLength(p.body), 1000),
    );
  });
  it("clamps every spelling of the output limit and defaults to the model cap", () => {
    const p = prepareRequest(
      "/chat/completions",
      JSON.stringify({ model: "m-test", messages: [], max_tokens: 10, max_completion_tokens: 50 }),
      prices,
      1,
    );
    const parsed = JSON.parse(p.body);
    expect(parsed.max_completion_tokens).toBe(10);
    expect(parsed.max_tokens).toBeUndefined();
    expect(JSON.parse(prepareRequest("/responses", body(), prices, 1).body).max_output_tokens).toBe(
      1000,
    );
  });
  it("rejects requests whose cost cannot be bounded", () => {
    const bad: [string, string][] = [
      ["unknown model", JSON.stringify({ model: "other" })],
      ["prototype model", JSON.stringify({ model: "__proto__" })],
      ["multiple choices", body({ n: 2 })],
      ["background", body({ background: true })],
      ["service tier", body({ service_tier: "priority" })],
      ["hosted tool", body({ tools: [{ type: "web_search" }] })],
      ["image input", body({ input: [{ type: "input_image", image_url: "x" }] })],
      ["bad limit", body({ max_output_tokens: -1 })],
      ["not json", "{"],
      ["array", "[]"],
    ];
    for (const [, raw] of bad)
      expect(() => prepareRequest("/responses", raw, prices, 1)).toThrow(GatewayError);
    expect(() =>
      prepareRequest("/responses", body({ pad: "x".repeat(1_000_001) }), prices, 1),
    ).toThrow(/size/);
    expect(() => prepareRequest("/models", body(), prices, 1)).toThrow(/Unsupported/);
  });
  it("enforces the per-call cap", () => {
    expect(() => prepareRequest("/responses", body(), prices, 0.000001)).toThrow(/ceiling/);
  });
  it("reads usage from both API shapes and rejects invalid usage", () => {
    expect(extractUsage({ usage: { input_tokens: 1, output_tokens: 2 } })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(extractUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(extractUsage({ response: { usage: { input_tokens: 5, output_tokens: 6 } } })).toEqual({
      inputTokens: 5,
      outputTokens: 6,
    });
    for (const v of [
      null,
      {},
      { usage: { input_tokens: -1, output_tokens: 1 } },
      { usage: { input_tokens: "1", output_tokens: 1 } },
    ]) {
      expect(extractUsage(v)).toBeNull();
    }
  });
});

describe("gateway flow", () => {
  it("admits, dispatches, forwards once with the server key, and settles at reported usage", async () => {
    const h = harness();
    const res = await h.send();
    expect(res.status).toBe(200);
    expect(h.calls.map((c) => c.split(":")[0])).toEqual(["admit", "dispatch", "settle"]);
    expect(h.upstreamFn).toHaveBeenCalledTimes(1);
    const [path, init] = h.upstreamFn.mock.calls[0]!;
    expect(path).toBe("/v1/responses");
    expect((init as RequestInit).redirect).toBe("error");
    expect(((init as RequestInit).headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk-test-key",
    );
    expect(h.calls[2]).toBe(`settle:${costUsd(prices["m-test"]!, 10, 20)}`);
    expect(await res.text()).not.toContain("sk-test-key");
  });
  it.each([
    ["missing key", { providerKey: () => undefined }],
    [
      "unauthenticated",
      {
        authenticate: async () => {
          throw new GatewayError(401, "no");
        },
      },
    ],
    [
      "unconfigured prices",
      {
        prices: () => {
          throw new GatewayError(503, "no");
        },
      },
    ],
    [
      "admission refused",
      {
        admit: async () => {
          throw new Error("blocked");
        },
      },
    ],
  ] as const)("fails closed without any upstream call: %s", async (_n, over) => {
    const h = harness(over as Partial<GatewayDeps>);
    const res = await h.send();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.upstreamFn).not.toHaveBeenCalled();
  });
  it("aborts the reservation and never sends when dispatch is blocked (Emergency Stop)", async () => {
    const h = harness({
      dispatch: async () => {
        throw new Error("stopped");
      },
    });
    const res = await h.send();
    expect(res.status).toBe(409);
    expect(h.calls.some((c) => c.startsWith("abort"))).toBe(true);
    expect(h.upstreamFn).not.toHaveBeenCalled();
  });
  it("rejects non-POST and unsupported paths before admission", async () => {
    const h = harness();
    expect((await h.send("/responses", "", "GET")).status).toBe(405);
    expect((await h.send("/files")).status).toBe(404);
    expect(h.calls).toEqual([]);
  });
  it("keeps the ceiling held (unknown) on network failure, never retries", async () => {
    const h = harness({}, async () => {
      throw new Error("socket");
    });
    const res = await h.send();
    expect(res.status).toBe(502);
    expect(h.calls.at(-1)).toMatch(/^unknown:/);
    expect(h.upstreamFn).toHaveBeenCalledTimes(1);
  });
  it("holds on 5xx and on 2xx without usage, but settles zero for definite client errors", async () => {
    const five = harness({}, async () => new Response("boom", { status: 500 }));
    await five.send();
    expect(five.calls.at(-1)).toMatch(/^unknown:/);
    const noUsage = harness({}, async () => Response.json({ ok: true }));
    await noUsage.send();
    expect(noUsage.calls.at(-1)).toMatch(/^unknown:/);
    const four = harness({}, async () => Response.json({ error: "bad" }, { status: 400 }));
    await four.send();
    expect(four.calls.at(-1)).toBe("settle:0");
  });
  it("does not return provider output as success when the cost cannot be recorded", async () => {
    const h = harness({
      settle: async () => {
        throw new Error("db down");
      },
    });
    const res = await h.send();
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("usage");
  });
  it("each retry is a fresh admission; concurrent calls each admit independently", async () => {
    let n = 0;
    const h = harness({ newKey: () => `key${++n}`.padEnd(16, "0") });
    await Promise.all([h.send(), h.send(), h.send()]);
    expect(h.calls.filter((c) => c.startsWith("admit"))).toHaveLength(3);
    expect(h.upstreamFn).toHaveBeenCalledTimes(3);
  });
});

describe("streaming", () => {
  const sse = (events: string[], cut = false) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(new TextEncoder().encode(e));
          if (cut) c.error(new Error("cut"));
          else c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const done = `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 9 } } })}\n\n`;

  it("settles at the usage in the final event after the stream ends", async () => {
    const h = harness({}, async () => sse(['data: {"type":"delta"}\n\n', done]));
    const res = await h.send("/responses", body({ stream: true }));
    expect(await res.text()).toContain("response.completed");
    expect(h.calls.at(-1)).toBe(`settle:${costUsd(prices["m-test"]!, 7, 9)}`);
  });
  it("forces include_usage on chat streams", async () => {
    const h = harness({}, async () => sse([done]));
    await h.send(
      "/chat/completions",
      JSON.stringify({ model: "m-test", messages: [], stream: true }),
    );
    const init = h.upstreamFn.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string).stream_options).toEqual({ include_usage: true });
  });
  it("holds the full ceiling when a stream ends without usage or is cut", async () => {
    const none = harness({}, async () => sse(['data: {"type":"delta"}\n\n']));
    await (await none.send("/responses", body({ stream: true }))).text();
    expect(none.calls.at(-1)).toMatch(/^unknown:/);
    const cut = harness({}, async () => sse(["data: {}\n\n"], true));
    await (await cut.send("/responses", body({ stream: true }))).text().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(cut.calls.at(-1)).toMatch(/^unknown:/);
  });
  it("holds the ceiling when the client cancels without usage", async () => {
    const never = new Response(new ReadableStream({ start() {} }), {
      headers: { "content-type": "text/event-stream" },
    });
    const h = harness({}, async () => never);
    const res = await h.send("/responses", body({ stream: true }));
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.at(-1)).toMatch(/^unknown:/);
  });
});

describe("Emergency Stop while a request is in flight", () => {
  it("aborts the upstream request and keeps the ceiling held", async () => {
    vi.useFakeTimers();
    try {
      let stopped = false;
      const h = harness(
        { isStopped: async () => stopped },
        () => new Promise<Response>(() => undefined),
      );
      h.upstreamFn.mockImplementation(
        (_p: string, init: RequestInit) =>
          new Promise<Response>((_res, rej) =>
            init.signal!.addEventListener("abort", () => rej(new Error("aborted"))),
          ),
      );
      const pending = h.send();
      await vi.advanceTimersByTimeAsync(GATEWAY_STOP_POLL_MS + 10);
      expect(h.calls.at(-1)).toBe("dispatch");
      stopped = true;
      await vi.advanceTimersByTimeAsync(GATEWAY_STOP_POLL_MS + 10);
      const res = await pending;
      expect(res.status).toBe(502);
      expect(h.calls.at(-1)).toMatch(/^unknown:/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("no outbound access except the injected upstream", () => {
  it("never touches global fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await harness().send();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
