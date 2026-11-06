import { describe, expect, it } from "vitest";
import { LINK_PATH, linkRequestUrl } from "./omni-session";
import { handleOmniLink, type LinkConfig, type LinkStore } from "./omni-session.server";

const ORIGIN = "https://jackboy-link.up.railway.app";
const railway = { OMNI_LINK_BEHIND_HTTPS_PROXY: "true", JACKBOY_LINK_ORIGIN: ORIGIN };
const proxied = (headers: Record<string, string>, url = "http://10.0.0.5:8080" + LINK_PATH) =>
  new Request(url, { method: "POST", headers, body: "{}" });
const good = { "x-forwarded-proto": "https", host: "jackboy-link.up.railway.app" };

describe("OMNI link behind Railway's HTTPS edge", () => {
  it("accepts forwarded https with a matching host only when the proxy flag is on", () => {
    expect(linkRequestUrl(proxied(good), railway)?.href).toBe(ORIGIN + LINK_PATH);
  });
  it("rejects plain http when the proxy flag is off", () => {
    expect(linkRequestUrl(proxied(good), { JACKBOY_LINK_ORIGIN: ORIGIN })).toBeNull();
    expect(linkRequestUrl(proxied(good), { ...railway, OMNI_LINK_BEHIND_HTTPS_PROXY: "1" })).toBeNull();
  });
  it("rejects forwarded http, a missing header, or a spoofed earlier https value", () => {
    expect(linkRequestUrl(proxied({ ...good, "x-forwarded-proto": "http" }), railway)).toBeNull();
    expect(linkRequestUrl(proxied({ host: good.host }), railway)).toBeNull();
    expect(linkRequestUrl(proxied({ ...good, "x-forwarded-proto": "https, http" }), railway)).toBeNull();
  });
  it("rejects a host that does not match JACKBOY_LINK_ORIGIN", () => {
    expect(linkRequestUrl(proxied({ ...good, host: "evil.example" }), railway)).toBeNull();
    expect(
      linkRequestUrl(proxied({ ...good, "x-forwarded-host": "evil.example" }), railway),
    ).toBeNull();
  });
  it("rejects a non-https or unclean JACKBOY_LINK_ORIGIN", () => {
    for (const origin of ["http://jackboy-link.up.railway.app", ORIGIN + "/x", "", "not a url"]) {
      expect(linkRequestUrl(proxied(good), { ...railway, JACKBOY_LINK_ORIGIN: origin })).toBeNull();
    }
  });
  it("leaves direct https requests unchanged with or without the flag", () => {
    const direct = new Request("https://jackboy.test" + LINK_PATH, { method: "POST" });
    expect(linkRequestUrl(direct, {})?.href).toBe("https://jackboy.test" + LINK_PATH);
    expect(linkRequestUrl(direct, railway)?.href).toBe("https://jackboy.test" + LINK_PATH);
  });
});

describe("link handler uses the proxy rule", () => {
  const config: LinkConfig = {
    clientId: "omni-test",
    projectId: "11111111-1111-4111-8111-111111111111",
    ownerId: "22222222-2222-4222-8222-222222222222",
    approvalId: "33333333-3333-4333-8333-333333333333",
    approvalExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    bootstrap: "b".repeat(64),
    secret: "s".repeat(64),
  };
  const store: LinkStore = async () => ({ http: 200 });
  it("refuses proxied http without the flag and stays disabled without config", async () => {
    const off = await handleOmniLink(proxied(good), config, store, async () => false, {});
    expect(off.status).toBe(400);
    expect((await off.json()).error).toBe("https_post_required");
    const disabled = await handleOmniLink(proxied(good), null, store, async () => false, railway);
    expect(disabled.status).toBe(503);
  });
  it("passes the transport check behind Railway and still requires a valid signature", async () => {
    const res = await handleOmniLink(proxied(good), config, store, async () => false, railway);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("authentication_failed");
  });
});
