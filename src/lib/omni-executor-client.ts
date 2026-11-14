import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export async function signedExecutorRequest(
  origin: string,
  secret: string,
  operation: string,
  args: Record<string, unknown>,
) {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ operation, args });
  const path = "/omni-autonomous/v1";
  const mac = (text: string) => createHmac("sha256", secret).update(text).digest("hex");
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(35_000),
    headers: {
      "Content-Type": "application/json",
      "X-Executor-Timestamp": timestamp,
      "X-Executor-Nonce": nonce,
      "X-Executor-Signature": mac(`omni.autonomous/v1\n${path}\n${timestamp}\n${nonce}\n${body}`),
    },
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Executor reply missing");
  let text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (text.length + value.byteLength > 65536) throw new Error("Executor reply exceeds limit");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const actual = Buffer.from(response.headers.get("X-Executor-Proof") ?? "");
  const expected = Buffer.from(
    mac(`omni.autonomous/v1\nresponse\n${nonce}\n${response.status}\n${text}`),
  );
  if (!response.ok || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Executor proof or status failed");
  return JSON.parse(text) as unknown;
}
