// Which web addresses may run passkey ceremonies. A passkey is bound to the host it was created on,
// so a key made on the preview will not work on the published site and vice versa.
const PROJECT_ID = "72823346-c174-4e90-9e17-671e197837c5";
const ALLOWED = [
  /^jackboy-dev-control\.lovable\.app$/,
  new RegExp(`^(?:id-preview|preview)(?:-[a-z0-9]+)?--${PROJECT_ID}\\.lovable\\.app$`),
  new RegExp(`^(?:[a-z0-9-]+--)?${PROJECT_ID}(?:-dev)?\\.lovableproject(?:-dev)?\\.com$`),
  /^localhost$/,
];

export function passkeyOrigin(origin: string): { origin: string; rpID: string } {
  let u: URL;
  try { u = new URL(origin); } catch { throw new Error("Passkeys need a valid page address."); }
  const host = u.hostname.toLowerCase();
  if (!ALLOWED.some((r) => r.test(host))) throw new Error(`Passkeys aren't enabled for ${host}. Use the published site or the preview.`);
  if (u.protocol !== "https:" && host !== "localhost") throw new Error("Passkeys need a secure (https) address.");
  return { origin: u.origin, rpID: host };
}

/** Friendly text for browser WebAuthn errors. */
export function passkeyErrorText(e: unknown, inFrame: boolean): string {
  const name = (e as { name?: string })?.name ?? "";
  const msg = (e as Error)?.message ?? String(e);
  if (inFrame && (name === "NotAllowedError" || name === "SecurityError")) return "Passkeys can't run inside the editor frame. Open the app in its own tab and try again.";
  if (name === "NotAllowedError") return "The passkey prompt was cancelled or timed out. Try again and confirm on your device.";
  if (name === "InvalidStateError") return "This device already has a passkey for this site.";
  if (name === "SecurityError") return "This address isn't allowed to use passkeys.";
  if (name === "NotSupportedError") return "This device doesn't support the kind of passkey needed.";
  return msg;
}
