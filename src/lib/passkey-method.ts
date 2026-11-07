// Works out how this device will confirm a passkey, so the passkey window can name the real method
// ("Use Face ID", "Use Windows Hello", "Use 1Password", "Use your phone") instead of a generic list.
// The browser still decides the final sheet; we only steer it with WebAuthn `hints` and wording.
export type PasskeyHint = "client-device" | "hybrid" | "security-key";
export type PasskeyMethodId =
  | "face_id" | "touch_id" | "ipad_unlock" | "windows_hello" | "android_unlock"
  | "password_manager" | "phone" | "security_key" | "device";
export type PasskeyMethod = { id: PasskeyMethodId; label: string; button: string; instruction: string; hints: PasskeyHint[] };
export type SavedKey = { label?: string | null; transports?: string[] | null };
export type DeviceSignals = {
  ua: string;
  maxTouchPoints?: number;
  /** Result of PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); null when unknown. */
  platformAuthenticator: boolean | null;
  /** Passkeys saved for this site (label + transports reported at registration). */
  keys: SavedKey[];
  /** How the last successful check on this device was done ("platform" = built-in, "cross-platform" = phone/key). */
  lastAttachment?: "platform" | "cross-platform" | null;
};

const MANAGERS: [RegExp, string][] = [
  [/1\s?password/i, "1Password"], [/bitwarden/i, "Bitwarden"], [/dashlane/i, "Dashlane"], [/keeper/i, "Keeper"],
  [/proton/i, "Proton Pass"], [/lastpass/i, "LastPass"], [/nordpass/i, "NordPass"], [/enpass/i, "Enpass"],
];

export type Os = "iphone" | "ipad" | "mac" | "windows" | "android" | "other";
export function detectOs(ua: string, maxTouchPoints = 0): Os {
  if (/iPhone|iPod/i.test(ua)) return "iphone";
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) return "ipad";
  if (/Android/i.test(ua)) return "android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  return "other";
}

const BUILT_IN: Record<Exclude<Os, "other">, Omit<PasskeyMethod, "hints">> = {
  iphone: { id: "face_id", label: "Face ID", button: "Use Face ID", instruction: "Look at your iPhone to confirm. Your passkey is in iCloud Keychain." },
  ipad: { id: "ipad_unlock", label: "iPad unlock", button: "Unlock with this iPad", instruction: "Confirm with this iPad's Face ID or Touch ID. Your passkey is in iCloud Keychain." },
  mac: { id: "touch_id", label: "Touch ID", button: "Use Touch ID", instruction: "Rest your finger on Touch ID to confirm." },
  windows: { id: "windows_hello", label: "Windows Hello", button: "Use Windows Hello", instruction: "Confirm with Windows Hello (face, fingerprint or PIN — whichever this PC is set up for)." },
  android: { id: "android_unlock", label: "fingerprint or screen lock", button: "Use fingerprint", instruction: "Confirm with this phone's fingerprint or screen lock." },
};

/** Pick the one method this device will most likely use. Pure: same signals → same answer. */
export function detectPasskeyMethod(s: DeviceSignals): PasskeyMethod {
  const os = detectOs(s.ua, s.maxTouchPoints);
  const transports = s.keys.flatMap((k) => k.transports ?? []);
  const has = (t: string) => transports.includes(t);
  const manager = s.keys.map((k) => MANAGERS.find(([re]) => re.test(k.label ?? ""))?.[1]).find(Boolean);

  // A third-party password manager the owner named when saving the passkey takes over the browser prompt.
  if (manager && s.lastAttachment !== "cross-platform") {
    return { id: "password_manager", label: manager, button: `Use ${manager}`, instruction: `Your passkey is saved in ${manager}. Approve it in the ${manager} window that opens.`, hints: ["client-device"] };
  }
  const builtInUsable = s.platformAuthenticator !== false && os !== "other" && (transports.length === 0 || has("internal") || has("hybrid"));
  if (builtInUsable && s.lastAttachment !== "cross-platform") return { ...BUILT_IN[os as Exclude<Os, "other">], hints: ["client-device"] };
  if (has("hybrid") || (s.platformAuthenticator === false && !has("usb") && !has("nfc") && !has("ble"))) {
    return { id: "phone", label: "your phone", button: "Use your phone", instruction: "Scan the code with the phone that holds your passkey, then confirm on the phone.", hints: ["hybrid"] };
  }
  if (has("usb") || has("nfc") || has("ble")) {
    return { id: "security_key", label: "security key", button: "Use security key", instruction: "Insert or tap your security key, then touch it to confirm.", hints: ["security-key"] };
  }
  return { id: "device", label: "passkey", button: "Use passkey", instruction: "Confirm on your device when it asks.", hints: [] };
}

const LAST_KEY = "jackboy.passkey.attachment";
export function rememberAttachment(a: unknown) {
  if (a !== "platform" && a !== "cross-platform") return;
  try { localStorage.setItem(LAST_KEY, a); } catch { /* storage blocked */ }
}
export function lastAttachment(): "platform" | "cross-platform" | null {
  try { const v = localStorage.getItem(LAST_KEY); return v === "platform" || v === "cross-platform" ? v : null; } catch { return null; }
}

/** Browser-side signal gathering. Never throws. */
export async function readDeviceSignals(keys: SavedKey[]): Promise<DeviceSignals> {
  let platform: boolean | null = null;
  try {
    const PKC = (window as unknown as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } }).PublicKeyCredential;
    if (PKC?.isUserVerifyingPlatformAuthenticatorAvailable) platform = await Promise.race([PKC.isUserVerifyingPlatformAuthenticatorAvailable(), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
  } catch { platform = null; }
  return { ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, platformAuthenticator: platform, keys, lastAttachment: lastAttachment() };
}

/** Rejects with `message` if `p` doesn't settle within `ms`. Keeps every passkey step from hanging. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
