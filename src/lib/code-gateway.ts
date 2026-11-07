// CODE provider admission gateway: the only component allowed to hold CODE provider credentials.
// Every upstream request is admitted against an atomic database reservation first, is bounded by a
// worst-case ceiling, is never retried upstream, and settles at the provider-reported usage.
// Anything uncertain keeps its full ceiling reserved. No network or database access lives here
// except through the injected dependencies, so it is fully testable with mocks.

export type ModelPrice = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  maxInputTokens: number;
  maxOutputTokens: number;
};
export type PriceTable = Record<string, ModelPrice>;

export const GATEWAY_MAX_BODY_BYTES = 1_000_000;
export const GATEWAY_UPSTREAM_TIMEOUT_MS = 10 * 60_000;
export const GATEWAY_STOP_POLL_MS = 5_000;
const PATHS = { "/responses": "responses", "/chat/completions": "chat" } as const;

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parsePriceTable(raw: string | undefined): PriceTable {
  if (!raw) throw new GatewayError(503, "CODE provider pricing is not configured.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new GatewayError(503, "CODE provider pricing is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(503, "CODE provider pricing is invalid.");
  }
  const table: PriceTable = Object.create(null) as PriceTable;
  for (const [model, price] of Object.entries(value)) {
    const p = price as Partial<ModelPrice>;
    if (
      !/^[\w.:-]{1,100}$/.test(model) ||
      !p ||
      typeof p !== "object" ||
      !Number.isFinite(p.inputPerMillionUsd) ||
      !Number.isFinite(p.outputPerMillionUsd) ||
      !Number.isSafeInteger(p.maxInputTokens) ||
      (p.maxInputTokens as number) < 1 ||
      (p.maxInputTokens as number) > 10_000_000 ||
      !Number.isInteger(p.maxOutputTokens) ||
      (p.inputPerMillionUsd as number) <= 0 ||
      (p.outputPerMillionUsd as number) <= 0 ||
      (p.maxOutputTokens as number) < 1 ||
      (p.maxOutputTokens as number) > 200_000
    ) {
      throw new GatewayError(503, "CODE provider pricing is invalid.");
    }
    table[model] = p as ModelPrice;
  }
  if (!Object.keys(table).length) throw new GatewayError(503, "CODE provider pricing is empty.");
  return table;
}

const microUsd = (usd: number) => Math.ceil(usd * 1e6 - 1e-9) / 1e6;

export function costUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return microUsd(
    (inputTokens * price.inputPerMillionUsd + outputTokens * price.outputPerMillionUsd) / 1e6,
  );
}

export type Prepared = {
  kind: "responses" | "chat";
  model: string;
  stream: boolean;
  body: string;
  ceilingUsd: number;
  price: ModelPrice;
};

// Rejects anything whose cost cannot be bounded in advance (tools with per-call fees, multiple choices,
// background jobs, non-text inputs, unknown models) and clamps the output ceiling.
export function prepareRequest(
  path: string,
  rawBody: string,
  prices: PriceTable,
  perCallCapUsd: number,
): Prepared {
  const kind = (PATHS as Record<string, "responses" | "chat" | undefined>)[path];
  if (!kind) throw new GatewayError(404, "Unsupported provider endpoint.");
  const bytes = Buffer.byteLength(rawBody);
  if (bytes < 2 || bytes > GATEWAY_MAX_BODY_BYTES)
    throw new GatewayError(413, "Invalid request size.");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new GatewayError(400, "Invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayError(400, "Invalid JSON.");
  }
  const model = body["model"];
  if (typeof model !== "string" || !Object.hasOwn(prices, model)) {
    throw new GatewayError(403, "Model is not approved for CODE.");
  }
  const price = prices[model]!;
  if (!Number.isFinite(perCallCapUsd) || perCallCapUsd <= 0 || perCallCapUsd > 5) {
    throw new GatewayError(503, "Invalid per-call spending cap.");
  }
  if (
    body["previous_response_id"] !== undefined ||
    body["conversation"] !== undefined ||
    body["prompt"] !== undefined ||
    body["audio"] !== undefined ||
    body["modalities"] !== undefined ||
    body["background"] === true ||
    (body["n"] !== undefined && body["n"] !== 1) ||
    body["service_tier"] !== undefined ||
    body["web_search_options"] !== undefined ||
    (body["stream"] !== undefined && typeof body["stream"] !== "boolean")
  ) {
    throw new GatewayError(400, "Request options cannot be cost-bounded.");
  }
  const tools = body["tools"];
  if (tools !== undefined) {
    if (
      !Array.isArray(tools) ||
      tools.some((t) => (t as { type?: unknown })?.type !== "function")
    ) {
      throw new GatewayError(400, "Only function tools can be cost-bounded.");
    }
  }
  // Inspect decoded JSON too: escaped property names must not evade the modality guard.
  const decoded = JSON.stringify(body);
  if (
    /"(?:image_url|input_image|input_file|input_audio|file_id|file|encrypted_content)"\s*:/.test(
      decoded,
    ) ||
    /"type"\s*:\s*"(?:input_image|input_file|input_audio|image_url|file|audio|item_reference)"/.test(
      decoded,
    )
  ) {
    throw new GatewayError(400, "Non-text inputs cannot be cost-bounded.");
  }
  const outKey = kind === "responses" ? "max_output_tokens" : "max_completion_tokens";
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const v = body[key];
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 1)) {
      throw new GatewayError(400, "Invalid token limit.");
    }
  }
  const requested = Math.min(
    ...(["max_tokens", "max_completion_tokens", "max_output_tokens"] as const)
      .map((k) => body[k] as number | undefined)
      .filter((v): v is number => v !== undefined),
    price.maxOutputTokens,
  );
  delete body["max_tokens"];
  delete body["max_completion_tokens"];
  delete body["max_output_tokens"];
  body[outKey] = requested;
  const stream = body["stream"] === true;
  if (stream && kind === "chat") body["stream_options"] = { include_usage: true };
  const out = JSON.stringify(body);
  // Reserve the entire independently verified model input window. Body bytes cannot bound
  // provider-added framing, and stored context is rejected above rather than priced heuristically.
  const ceilingUsd = costUsd(price, price.maxInputTokens, requested);
  if (!(ceilingUsd > 0) || ceilingUsd > perCallCapUsd) {
    throw new GatewayError(413, "Request exceeds the per-call spending ceiling.");
  }
  return { kind, model, stream, body: out, ceilingUsd, price };
}

export type Usage = { inputTokens: number; outputTokens: number };

export function extractUsage(value: unknown): Usage | null {
  const root = value as Record<string, unknown> | null;
  const usage = ((root?.["response"] as Record<string, unknown> | undefined)?.["usage"] ??
    root?.["usage"]) as Record<string, unknown> | null | undefined;
  if (!usage || typeof usage !== "object") return null;
  const input = usage["input_tokens"] ?? usage["prompt_tokens"];
  const output = usage["output_tokens"] ?? usage["completion_tokens"];
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return null;
  if ((input as number) < 0 || (output as number) < 0) return null;
  return { inputTokens: input as number, outputTokens: output as number };
}

export type Identity = { requestId: string; runId: number };

export type GatewayDeps = {
  authenticate(request: Request): Promise<Identity>;
  admit(identity: Identity, callKey: string, model: string, ceilingUsd: number): Promise<string>;
  dispatch(callId: string): Promise<void>;
  abort(callId: string, reason: string): Promise<void>;
  settle(callId: string, actualUsd: number, providerRequestId: string | null): Promise<void>;
  markUnknown(callId: string, reason: string): Promise<void>;
  isStopped(identity: Identity): Promise<boolean>;
  providerKey(): string | undefined;
  prices(): PriceTable;
  perCallCapUsd(): number;
  upstream(path: string, init: RequestInit): Promise<Response>;
  newKey(): string;
};

const reply = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export function createCodeGateway(deps: GatewayDeps) {
  return async function handle(request: Request): Promise<Response> {
    let callId: string | null = null;
    let dispatched = false;
    try {
      if (request.method !== "POST") return reply(405, "Method not allowed.");
      const path = new URL(request.url).pathname.replace(
        /^.*\/api\/public\/code\/provider\/v1/,
        "",
      );
      const apiKey = deps.providerKey();
      if (!apiKey) return reply(503, "CODE provider gateway is not configured.");
      const identity = await deps.authenticate(request);
      if (request.signal.aborted) return reply(409, "CODE request was cancelled.");
      const prepared = prepareRequest(
        path,
        await request.text(),
        deps.prices(),
        deps.perCallCapUsd(),
      );
      callId = await deps.admit(identity, deps.newKey(), prepared.model, prepared.ceilingUsd);
      try {
        if (request.signal.aborted) throw new GatewayError(409, "CODE request was cancelled.");
        await deps.dispatch(callId);
      } catch {
        await deps.abort(callId, "dispatch blocked");
        callId = null;
        return reply(409, "CODE provider call blocked.");
      }
      dispatched = true;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_UPSTREAM_TIMEOUT_MS);
      const stopAndHold = () => controller.abort();
      const stopWatcher = setInterval(() => {
        deps.isStopped(identity).then((stopped) => stopped && stopAndHold(), stopAndHold);
      }, GATEWAY_STOP_POLL_MS);
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(stopWatcher);
        request.signal.removeEventListener("abort", stopAndHold);
      };
      request.signal.addEventListener("abort", stopAndHold, { once: true });
      if (request.signal.aborted) controller.abort();

      let upstream: Response;
      try {
        upstream = await deps.upstream(`/v1${path}`, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: ["Bearer", apiKey].join(" "),
          },
          body: prepared.body,
        });
      } catch {
        cleanup();
        await deps.markUnknown(callId, "upstream request failed without a response");
        return reply(502, "CODE provider request failed; its cost is held until reconciled.");
      }

      const settleUsage = async (usage: Usage | null) => {
        const id = callId as string;
        if (usage) {
          await deps.settle(
            id,
            costUsd(prepared.price, usage.inputTokens, usage.outputTokens),
            upstream.headers.get("x-request-id"),
          );
        } else {
          await deps.markUnknown(id, `no usage reported (status ${upstream.status})`);
          throw new GatewayError(502, "Provider usage unavailable; the call stays reserved.");
        }
      };
      const headers = new Headers({
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      });

      if (!prepared.stream || !upstream.body) {
        let text: string;
        try {
          text = await upstream.text();
        } catch {
          cleanup();
          await deps.markUnknown(callId, "response body unreadable");
          return reply(
            502,
            "CODE provider response was unreadable; its cost is held until reconciled.",
          );
        }
        cleanup();
        let usage: Usage | null = null;
        try {
          usage = extractUsage(JSON.parse(text));
        } catch {
          usage = null;
        }
        try {
          await settleUsage(usage);
        } catch {
          return reply(502, "CODE provider cost could not be recorded; the call stays reserved.");
        }
        return new Response(text, { status: upstream.status, headers });
      }

      const id = callId;
      let usage: Usage | null = null;
      let completed = false;
      let buffer = "";
      const decoder = new TextDecoder();
      const reader = upstream.body.getReader();
      const out = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              cleanup();
              try {
                await settleUsage(completed ? usage : null);
              } catch {
                streamController.error(new Error("cost not recorded"));
                return;
              }
              streamController.close();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            if (buffer.length > GATEWAY_MAX_BODY_BYTES) {
              controller.abort();
              throw new Error("Provider event exceeds the gateway limit.");
            }
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              if (line.trim() === "data: [DONE]") {
                if (prepared.kind === "chat") completed = true;
                continue;
              }
              try {
                const event = JSON.parse(line.slice(5)) as { type?: string };
                if (prepared.kind === "chat" || event.type === "response.completed") {
                  usage = extractUsage(event) ?? usage;
                  if (prepared.kind === "responses" && event.type === "response.completed")
                    completed = true;
                }
              } catch {
                /* partial or non-JSON event */
              }
            }
            streamController.enqueue(value);
          } catch {
            cleanup();
            await deps.markUnknown(id, "stream interrupted").catch(() => undefined);
            streamController.error(new Error("stream interrupted"));
          }
        },
        async cancel() {
          controller.abort();
          cleanup();
          await reader.cancel().catch(() => undefined);
          await deps.markUnknown(id, "client cancelled the stream");
        },
      });
      return new Response(out, { status: upstream.status, headers });
    } catch (error) {
      if (callId && !dispatched)
        await deps.abort(callId, "request failed before dispatch").catch(() => undefined);
      if (error instanceof GatewayError) return reply(error.status, error.message);
      return reply(403, "CODE provider gateway failed closed.");
    }
  };
}
