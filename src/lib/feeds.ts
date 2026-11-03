// Pure feed parsing and tagging (no I/O).
import { htmlToText } from "./html-text";
export type ParsedItem = { title: string; url: string | null; summary: string; published_at: string | null };

const decode = (s: string) => htmlToText(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]!) : null;
}

/** Parses RSS 2.0 <item> and Atom <entry> blocks. Returns at most `limit` items. */
export function parseFeed(xml: string, limit = 20): ParsedItem[] {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  return blocks.slice(0, limit).map((b) => {
    const atomLink = /<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? null;
    const link = tag(b, "link") || atomLink;
    const date = tag(b, "pubDate") || tag(b, "updated") || tag(b, "published");
    const d = date ? new Date(date) : null;
    return {
      title: (tag(b, "title") || "(untitled)").slice(0, 300),
      url: link && /^https?:\/\//.test(link) ? link : null,
      summary: (tag(b, "description") || tag(b, "summary") || tag(b, "content") || "").slice(0, 1000),
      published_at: d && !isNaN(d.getTime()) ? d.toISOString() : null,
    };
  });
}

/** Visible text of an HTML page, for change monitoring. */
export function pageText(html: string): string {
  return htmlToText(html).slice(0, 20000);
}

/** Item goes to the source's projects; if the source has none, to projects whose name appears in the text. */
export function tagProjects(sourceProjects: string[], text: string, projects: { id: string; name: string }[]): string[] {
  if (sourceProjects.length) return sourceProjects;
  const t = text.toLowerCase();
  return projects.filter((p) => p.name.trim().length >= 3 && t.includes(p.name.toLowerCase())).map((p) => p.id);
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Only public http(s) URLs; blocks localhost and private network ranges. */
export function safeFetchUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" && x.protocol !== "http:") return false;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(":")) return false;
    return true;
  } catch { return false; }
}
