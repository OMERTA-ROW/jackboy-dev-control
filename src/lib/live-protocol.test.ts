import { describe, expect, it, vi } from "vitest";
import { LIVE_AUTH_PREFIX, LIVE_PROTOCOL, liveProtocols, liveTokenFromProtocols } from "./live-protocol";
import { authorizeLiveUpgrade } from "./live-relay.server";

const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const upgrade = (protocols?: string) =>
  new Request("https://jackboy.example/api/live", {
    headers: { upgrade: "websocket", origin: "https://jackboy.example", ...(protocols ? { "sec-websocket-protocol": protocols } : {}) },
  });

describe("voice connection protocol", () => {
  it("round-trips the owner token through the protocol list", () => {
    expect(liveTokenFromProtocols(liveProtocols(token).join(", "))).toBe(token);
  });
  it("rejects missing, malformed or ambiguous auth entries", () => {
    expect(liveTokenFromProtocols(null)).toBeNull();
    expect(liveTokenFromProtocols(`${LIVE_AUTH_PREFIX}${token}`)).toBeNull(); // protocol name missing
    expect(liveTokenFromProtocols(LIVE_PROTOCOL)).toBeNull(); // no token
    expect(liveTokenFromProtocols(`${LIVE_PROTOCOL}, ${LIVE_AUTH_PREFIX}short`)).toBeNull();
    expect(liveTokenFromProtocols(`${LIVE_PROTOCOL}, ${LIVE_AUTH_PREFIX}${token}, ${LIVE_AUTH_PREFIX}${token}x`)).toBeNull();
  });
});

describe("voice upgrade authorization happens before the socket is accepted", () => {
  it("refuses an upgrade without a session token and never calls the owner check", async () => {
    const verify = vi.fn(async (t: string) => t);
    const out = await authorizeLiveUpgrade(upgrade(), verify);
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });
  it("refuses a token that fails the owner check, with a reason-free message", async () => {
    const out = await authorizeLiveUpgrade(upgrade(liveProtocols(token).join(", ")), async () => {
      throw new Error("Voice is owner-only.");
    });
    expect((out as Response).status).toBe(401);
    expect(await (out as Response).text()).not.toContain("owner-only");
  });
  it("returns the verified token for the signed-in owner", async () => {
    const out = await authorizeLiveUpgrade(upgrade(liveProtocols(token).join(", ")), async (t) => t);
    expect(out).toEqual({ token });
  });
});
