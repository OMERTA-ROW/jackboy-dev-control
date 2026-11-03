/** Only public https addresses are accepted as a detected site. */
export function isSafeSiteUrl(v: string): boolean {
  try { const u = new URL(v); return u.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname); } catch { return false; }
}
/** "honeycomb-terminal" → "Honeycomb Terminal"; keeps trailing-dash/odd names readable. */
export function repoNameToDisplay(name: string): string {
  return name.replace(/[-_]+/g, " ").trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
