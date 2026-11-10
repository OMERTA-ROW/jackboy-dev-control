import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { hmacHex, safeEqual } from "./omni-link";
import {
  DISPATCH_V2,
  DISPATCH_V3,
  MAX_PAYLOAD_BYTES,
  V3_JOB_STATUSES,
  assertV3Expiry,
  utf8Bytes,
  type DispatchVersion,
} from "./omni-dispatch-v3";

const PATH = "/api/public/jackboy/dispatch";
const requestSchema = z
  .object({
    ownerId: z.string().uuid(),
    projectId: z.string().uuid(),
    grantId: z.string().uuid(),
    jobId: z.string().uuid(),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(200),
    kind: z.enum(["build", "test"]),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** v3 scope also carries the signed payload and expiry; both are sent only on submit. */
const v3RequestSchema = requestSchema
  .extend({
    payload: z.string().refine((s) => utf8Bytes(s) <= MAX_PAYLOAD_BYTES, "Payload over 6 KB."),
    expiresAt: z.number().int(),
  })
  .strict();
export type DispatchScope = z.infer<typeof requestSchema>;
export type DispatchScopeV3 = z.infer<typeof v3RequestSchema>;
type Action = "submit" | "status" | "cancel";
type Config = { origin: string; ca: string | Buffer; clientId: string; secret: string };
type Authorization = (scope: DispatchScope, action: Action) => Promise<boolean>;
type Audit = (event: string, scope: DispatchScope) => Promise<void>;

export class OmniDispatchClient {
  private readonly config: Config;
  private readonly authorize: Authorization;
  private readonly audit: Audit;
  private readonly version: DispatchVersion;

  constructor(config: Config, authorize: Authorization, audit: Audit, version: DispatchVersion = "v2") {
    this.config = config;
    this.authorize = authorize;
    this.audit = audit;
    if (version !== "v2" && version !== "v3") throw new Error("Invalid dispatch version.");
    this.version = version;
    const url = new URL(config.origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !config.ca.length ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(config.clientId) ||
      config.secret.length < 32
    )
      throw new Error("Invalid dispatch TLS or credential configuration.");
  }

  async send(action: Action, scope: DispatchScope | DispatchScopeV3) {
    if (!["submit", "status", "cancel"].includes(action)) throw new Error("Invalid action.");
    const v3 = this.version === "v3";
    const CONTRACT = v3 ? DISPATCH_V3 : DISPATCH_V2;
    const validated: DispatchScope | DispatchScopeV3 = v3
      ? v3RequestSchema.parse(scope)
      : requestSchema.parse(scope);
    if (!(await this.authorize(validated, action))) throw new Error("Dispatch grant unavailable.");
    // Right before transport: the signed expiry must still be in the future and <= 30 minutes out.
    if (v3) assertV3Expiry((validated as DispatchScopeV3).expiresAt);
    await this.audit(`request_${action}`, validated);
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const timestamp = String(Math.floor(Date.now() / 1000));
    let wire: Record<string, unknown> = { ...validated };
    if (v3 && action !== "submit") {
      const { payload: _payload, expiresAt: _expiresAt, ...rest } = validated as DispatchScopeV3;
      wire = rest;
    }
    const body = JSON.stringify({ contract: CONTRACT, action, ...wire });
    const signature = await hmacHex(
      this.config.secret,
      `${CONTRACT}\nPOST\n${PATH}\n${this.config.clientId}\n${timestamp}\n${nonce}\n${body}`,
    );
    const response = await new Promise<{ status: number; body: string; proof: string }>(
      (resolve, reject) => {
        const request = httpsRequest(
          new URL(PATH, this.config.origin),
          {
            method: "POST",
            ca: this.config.ca,
            timeout: 5000,
            headers: {
              "content-type": "application/json",
              "x-jackboy-client": this.config.clientId,
              "x-jackboy-timestamp": timestamp,
              "x-jackboy-nonce": nonce,
              "x-jackboy-signature": signature,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 8192) request.destroy(new Error("Dispatch response too large."));
              else chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () =>
              resolve({
                status: res.statusCode || 0,
                body: Buffer.concat(chunks).toString("utf8"),
                proof:
                  typeof res.headers["x-jackboy-proof"] === "string"
                    ? res.headers["x-jackboy-proof"]
                    : "",
              }),
            );
          },
        );
        request.on("timeout", () => request.destroy(new Error("Dispatch timed out.")));
        request.on("error", reject);
        request.end(body);
      },
    );
    if (response.status !== 200 && response.status !== 202)
      throw new Error(`Dispatch failed with HTTP ${response.status}.`);
    const proof = await hmacHex(
      this.config.secret,
      `${CONTRACT}\nresponse\n${nonce}\n${response.status}\n${response.body}`,
    );
    if (!safeEqual(response.proof, proof)) throw new Error("Invalid dispatch response proof.");
    const statuses = v3 ? V3_JOB_STATUSES : (["quarantined", "cancelled"] as const);
    const result = z
      .object({
        contract: z.literal(CONTRACT),
        requestNonce: z.literal(nonce),
        job: z
          .object({
            id: z.literal(validated.jobId),
            status: z.enum(statuses as unknown as [string, ...string[]]),
          })
          .strict(),
      })
      .strict()
      .parse(JSON.parse(response.body));
    await this.audit(`result_${result.job.status}`, validated);
    return result.job;
  }
}
