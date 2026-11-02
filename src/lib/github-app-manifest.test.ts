import { describe, expect, it } from "vitest";
import { buildManifest, decryptText, encryptText, manifestPostUrl, verifyWebhookSignature } from "./github-app-manifest";

describe("GitHub App manifest", () => {
  const m = buildManifest("https://jackboy-dev-control.lovable.app", "OMERTA-ROW");
  it("requests only least-privilege permissions", () => {
    expect(m.default_permissions).toEqual({ metadata: "read", contents: "write", pull_requests: "write", actions: "read", checks: "read" });
    expect(m.default_permissions).not.toHaveProperty("administration");
    expect(m.default_permissions).not.toHaveProperty("workflows");
  });
  it("is private and points back at Jackboy", () => {
    expect(m.public).toBe(false);
    expect(m.redirect_url).toBe("https://jackboy-dev-control.lovable.app/api/public/github/manifest");
    expect(m.hook_attributes.url).toBe("https://jackboy-dev-control.lovable.app/api/public/github/webhook");
  });
  it("rejects non-https origins and bad org names", () => {
    expect(() => buildManifest("http://evil.test", "x")).toThrow();
    expect(() => manifestPostUrl("bad/org", "s")).toThrow();
  });
  it("verifies webhook signatures and rejects tampering", async () => {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("{}"))), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await verifyWebhookSignature("{}", `sha256=${sig}`, "s3cret")).toBe(true);
    expect(await verifyWebhookSignature("{ }", `sha256=${sig}`, "s3cret")).toBe(false);
    expect(await verifyWebhookSignature("{}", null, "s3cret")).toBe(false);
  });
  it("encrypts round-trip and fails with the wrong key", async () => {
    const enc = await encryptText("PRIVATE", "k1");
    expect(enc).not.toContain("PRIVATE");
    expect(await decryptText(enc, "k1")).toBe("PRIVATE");
    await expect(decryptText(enc, "k2")).rejects.toThrow();
  });
});
