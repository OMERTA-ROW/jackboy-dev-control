import { beforeEach, describe, expect, it, vi } from "vitest";

type Sent = { headers: Record<string, string>; body: string };
const net = vi.hoisted(() => ({
  sent: [] as { headers: Record<string, string>; body: string }[],
  status: "running",
  badProof: false,
}));
const SECRET = "s".repeat(64);

vi.mock("node:https", () => ({
  request: (
    _url: URL,
    opts: { headers: Record<string, string> },
    cb: (res: unknown) => void,
  ) => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const req = {
      on: (event: string, fn: (e: unknown) => void) => {
        listeners[event] = fn;
        return req;
      },
      destroy: (e: unknown) => listeners["error"]?.(e),
      end: (body: string) => {
        net.sent.push({ headers: opts.headers, body });
        void (async () => {
          const { hmacHex } = await import("./omni-link");
          const contract = JSON.parse(body).contract as string;
          const nonce = opts.headers["x-jackboy-nonce"];
          const text = JSON.stringify({
            contract,
            requestNonce: nonce,
            job: { id: JSON.parse(body).jobId, status: net.status },
          });
          const proof = await hmacHex(SECRET, `${contract}\nresponse\n${nonce}\n202\n${text}`);
          const handlers: Record<string, (c?: unknown) => void> = {};
          cb({
            statusCode: 202,
            headers: { "x-jackboy-proof": net.badProof ? "0".repeat(64) : proof },
            on: (event: string, fn: (c?: unknown) => void) => (handlers[event] = fn),
          });
          handlers["data"]?.(Buffer.from(text));
          handlers["end"]?.();
        })();
      },
    };
    return req;
  },
}));

import { OmniDispatchClient } from "./omni-dispatch-client.server";
import { hmacHex } from "./omni-link";

const config = { origin: "https://omni.example", ca: "ca", clientId: "jackboy", secret: SECRET };
const scope = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  grantId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  repo: "acme/repo",
  kind: "test" as const,
  payloadDigest: "a".repeat(64),
};
const v3Scope = () => ({
  ...scope,
  payload: "go test ./...",
  expiresAt: Math.floor(Date.now() / 1000) + 600,
});
const allow = async () => true;
const audit = vi.fn(async () => {});

async function verifySignature(sent: Sent, contract: string) {
  const h = sent.headers;
  const expected = await hmacHex(
    SECRET,
    `${contract}\nPOST\n/api/public/jackboy/dispatch\n${h["x-jackboy-client"]}\n${h["x-jackboy-timestamp"]}\n${h["x-jackboy-nonce"]}\n${sent.body}`,
  );
  expect(h["x-jackboy-signature"]).toBe(expected);
}

beforeEach(() => {
  net.sent = [];
  net.status = "running";
  net.badProof = false;
  audit.mockClear();
});

describe("dispatch client v3", () => {
  it("signs submit with the v3 contract and includes payload + expiresAt", async () => {
    const client = new OmniDispatchClient(config, allow, audit, "v3");
    const s = v3Scope();
    expect(await client.send("submit", s)).toEqual({ id: scope.jobId, status: "running" });
    const sent = net.sent[0]!;
    expect(JSON.parse(sent.body)).toEqual({ contract: "jackboy.dispatch/v3", action: "submit", ...s });
    await verifySignature(sent, "jackboy.dispatch/v3");
    expect(audit).toHaveBeenLastCalledWith("result_running", s);
  });

  it("accepts every v3 job state and refuses unknown ones", async () => {
    for (const status of ["quarantined", "approved", "running", "completed", "failed", "cancelled", "expired"]) {
      net.status = status;
      const job = await new OmniDispatchClient(config, allow, audit, "v3").send("status", v3Scope());
      expect(job.status).toBe(status);
    }
    net.status = "deployed";
    await expect(
      new OmniDispatchClient(config, allow, audit, "v3").send("status", v3Scope()),
    ).rejects.toThrow();
  });

  it("status and cancel bodies carry no payload or expiry", async () => {
    await new OmniDispatchClient(config, allow, audit, "v3").send("status", v3Scope());
    const body = JSON.parse(net.sent[0]!.body);
    expect(body.contract).toBe("jackboy.dispatch/v3");
    expect(body).not.toHaveProperty("payload");
    expect(body).not.toHaveProperty("expiresAt");
  });

  it("refuses payloads over 6 KB and bad expiries before any network call", async () => {
    const client = new OmniDispatchClient(config, allow, audit, "v3");
    const now = Math.floor(Date.now() / 1000);
    await expect(client.send("submit", { ...v3Scope(), payload: "x".repeat(6145) })).rejects.toThrow();
    await expect(client.send("submit", { ...v3Scope(), expiresAt: now - 1 })).rejects.toThrow("expired");
    await expect(client.send("submit", { ...v3Scope(), expiresAt: now + 1801 })).rejects.toThrow("30 minutes");
    expect(net.sent).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects an invalid response proof", async () => {
    net.badProof = true;
    await expect(
      new OmniDispatchClient(config, allow, audit, "v3").send("submit", v3Scope()),
    ).rejects.toThrow("proof");
  });
});

describe("dispatch client v2 unchanged", () => {
  it("defaults to v2, sends the same body, and refuses v3-only states", async () => {
    net.status = "quarantined";
    const client = new OmniDispatchClient(config, allow, audit);
    expect(await client.send("submit", scope)).toEqual({ id: scope.jobId, status: "quarantined" });
    const sent = net.sent[0]!;
    expect(sent.body).toBe(JSON.stringify({ contract: "jackboy.dispatch/v2", action: "submit", ...scope }));
    await verifySignature(sent, "jackboy.dispatch/v2");
    net.status = "running";
    await expect(client.send("status", scope)).rejects.toThrow();
  });

  it("v2 refuses v3 fields in its scope", async () => {
    await expect(new OmniDispatchClient(config, allow, audit).send("submit", v3Scope())).rejects.toThrow();
    expect(net.sent).toHaveLength(0);
  });
});
