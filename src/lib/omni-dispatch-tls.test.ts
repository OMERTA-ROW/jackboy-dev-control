import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  readFile: vi.fn(),
  request: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("./untyped-db", () => ({ untyped: () => ({ rpc: mocks.rpc }) }));
vi.mock("./site-log.server", () => ({ logSiteStrict: vi.fn() }));
vi.mock("./omni-link.server", () => ({ isOmniVerified: vi.fn().mockResolvedValue(true) }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("node:https", () => ({
  request: mocks.request,
  default: { request: mocks.request },
}));

import { executeOmniReceipt } from "./omni-dispatch-execute.server";
import { executeOmniV3Receipt } from "./omni-dispatch-v3.server";

const secret = "synthetic-dispatch-secret-0123456789";
const ca = Buffer.from("synthetic custom CA bytes");
const scope = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  grantId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  repo: "acme/repo",
  kind: "test",
  payloadDigest: "a".repeat(64),
};

describe.each([
  ["v2", executeOmniReceipt],
  ["v3", executeOmniV3Receipt],
] as const)("%s dispatch TLS configuration", (_version, execute) => {
  const send = () => execute(scope.ownerId, scope.jobId, scope.grantId, "status");

  beforeEach(() => {
    vi.stubEnv("OMNI_DISPATCH_ENABLED", "true");
    vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", "true");
    vi.stubEnv("OMNI_DISPATCH_ORIGIN", "https://omni.example");
    vi.stubEnv("OMNI_DISPATCH_CLIENT_ID", "jackboy-test");
    vi.stubEnv("OMNI_DISPATCH_HMAC_SECRET", secret);
    vi.stubEnv("OMNI_DISPATCH_CA_FILE", undefined);
    mocks.readFile.mockReset().mockResolvedValue(ca);
    mocks.rpc.mockReset().mockImplementation((_name: string, args: { _op: string }) =>
      Promise.resolve({
        data:
          args._op === "read"
            ? scope
            : args._op === "check"
              ? { ...scope, valid: true, id: scope.grantId, instructions: "bounded request" }
              : true,
        error: null,
      }),
    );
    mocks.request
      .mockReset()
      .mockImplementation(
        (
          _url: URL,
          options: { headers: Record<string, string> },
          callback: (response: EventEmitter) => void,
        ) => {
          const request = new EventEmitter();
          return Object.assign(request, {
            end(raw: string) {
              const { contract } = JSON.parse(raw) as { contract: string };
              const nonce = options.headers["x-jackboy-nonce"];
              const body = JSON.stringify({
                contract,
                requestNonce: nonce,
                job: { id: scope.jobId, status: "quarantined" },
              });
              const proof = createHmac("sha256", secret)
                .update(`${contract}\nresponse\n${nonce}\n200\n${body}`)
                .digest("hex");
              const response = Object.assign(new EventEmitter(), {
                statusCode: 200,
                headers: { "x-jackboy-proof": proof },
              });
              callback(response);
              response.emit("data", Buffer.from(body));
              response.emit("end");
            },
          });
        },
      );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each([undefined, ""])(
    "uses default HTTPS trust without reading a CA file when the path is %s",
    async (path) => {
      vi.stubEnv("OMNI_DISPATCH_CA_FILE", path);
      await expect(send()).resolves.toEqual({ id: scope.jobId, status: "quarantined" });
      expect(mocks.readFile).not.toHaveBeenCalled();
      expect(mocks.request).toHaveBeenCalledTimes(1);
      const options = mocks.request.mock.calls[0]![1];
      expect(options).not.toHaveProperty("ca");
      expect(options).not.toHaveProperty("rejectUnauthorized");
      expect(mocks.request.mock.calls[0]![0].protocol).toBe("https:");
    },
  );

  it("reads a configured CA file and passes its exact bytes to HTTPS", async () => {
    vi.stubEnv("OMNI_DISPATCH_CA_FILE", "/synthetic/custom-ca.pem");
    await expect(send()).resolves.toEqual({ id: scope.jobId, status: "quarantined" });
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/synthetic/custom-ca.pem");
    const options = mocks.request.mock.calls[0]![1];
    expect(options.ca).toBe(ca);
    expect(options).not.toHaveProperty("rejectUnauthorized");
  });

  it("surfaces an unreadable configured CA file without transport or fallback", async () => {
    vi.stubEnv("OMNI_DISPATCH_CA_FILE", "/synthetic/missing-ca.pem");
    const error = new Error("ENOENT: configured CA file unavailable");
    mocks.readFile.mockRejectedValueOnce(error);
    await expect(send()).rejects.toBe(error);
    expect(mocks.readFile).toHaveBeenCalledExactlyOnceWith("/synthetic/missing-ca.pem");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects an empty configured CA file without transport or fallback", async () => {
    vi.stubEnv("OMNI_DISPATCH_CA_FILE", "/synthetic/empty-ca.pem");
    mocks.readFile.mockResolvedValueOnce(Buffer.alloc(0));
    await expect(send()).rejects.toThrow("Invalid dispatch TLS or credential configuration");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("propagates a configured CA TLS failure without retrying with system trust", async () => {
    vi.stubEnv("OMNI_DISPATCH_CA_FILE", "/synthetic/invalid-ca.pem");
    const invalidCa = Buffer.from("not a PEM certificate");
    const error = new Error("unable to get local issuer certificate");
    mocks.readFile.mockResolvedValueOnce(invalidCa);
    mocks.request.mockImplementationOnce(() => {
      const request = new EventEmitter();
      return Object.assign(request, { end: () => request.emit("error", error) });
    });
    await expect(send()).rejects.toBe(error);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0]![1].ca).toBe(invalidCa);
  });
});
