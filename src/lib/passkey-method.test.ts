import { describe, expect, it, vi } from "vitest";
import { detectOs, detectPasskeyMethod, withTimeout } from "./passkey-method";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const synced = [{ label: "iPhone", transports: ["hybrid", "internal"] }];

describe("passkey method detection", () => {
  it("iPhone with a built-in passkey goes straight to Face ID", () => {
    const m = detectPasskeyMethod({ ua: IPHONE, platformAuthenticator: true, keys: synced });
    expect(m.id).toBe("face_id");
    expect(m.button).toBe("Use Face ID");
    expect(m.hints).toEqual(["client-device"]);
  });
  it("iPad reporting a desktop browser is still treated as iPad", () => {
    expect(detectOs(MAC, 5)).toBe("ipad");
    expect(detectOs(MAC, 0)).toBe("mac");
  });
  it("Mac uses Touch ID, Windows uses Windows Hello, Android uses fingerprint", () => {
    expect(detectPasskeyMethod({ ua: MAC, platformAuthenticator: true, keys: synced }).id).toBe("touch_id");
    expect(detectPasskeyMethod({ ua: WIN, platformAuthenticator: true, keys: synced }).button).toBe("Use Windows Hello");
    expect(detectPasskeyMethod({ ua: ANDROID, platformAuthenticator: true, keys: synced }).id).toBe("android_unlock");
  });
  it("a passkey saved in a named password manager goes to that manager", () => {
    const m = detectPasskeyMethod({ ua: MAC, platformAuthenticator: true, keys: [{ label: "1Password", transports: ["internal", "hybrid"] }] });
    expect(m.id).toBe("password_manager");
    expect(m.button).toBe("Use 1Password");
  });
  it("no built-in authenticator but a phone-held passkey asks for the phone", () => {
    const m = detectPasskeyMethod({ ua: LINUX, platformAuthenticator: false, keys: synced });
    expect(m.id).toBe("phone");
    expect(m.hints).toEqual(["hybrid"]);
  });
  it("last check on this device used a phone or key: don't push the built-in method", () => {
    expect(detectPasskeyMethod({ ua: MAC, platformAuthenticator: true, keys: synced, lastAttachment: "cross-platform" }).id).toBe("phone");
  });
  it("a USB-only key asks for the security key", () => {
    const m = detectPasskeyMethod({ ua: WIN, platformAuthenticator: false, keys: [{ label: "YubiKey", transports: ["usb", "nfc"] }] });
    expect(m.id).toBe("security_key");
    expect(m.hints).toEqual(["security-key"]);
  });
});

describe("passkey steps never hang", () => {
  it("withTimeout rejects with the plain message when a step doesn't answer", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 1000, "Your device didn't answer in time.");
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow("Your device didn't answer in time.");
    vi.useRealTimers();
  });
  it("withTimeout passes through a result that arrives in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "late")).resolves.toBe(7);
  });
});
