// Converts untrusted HTML/XML to plain text. Output is never HTML: any leftover
// angle brackets are removed, so it is safe even if later rendered unescaped.
const BLOCKS = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*[^>]*>/gi;
const UNCLOSED_BLOCK = /<(script|style|noscript|template)\b[\s\S]*$/i;

export function stripTags(input: string): string {
  let s = input.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
  let prev: string;
  // Repeat until stable so nested/overlapping fragments ("<scr<script>ipt>") can't survive.
  do {
    prev = s;
    s = s.replace(BLOCKS, " ").replace(UNCLOSED_BLOCK, " ").replace(/<[^<>]*>/g, " ");
  } while (s !== prev);
  return s.replace(/[<>]/g, " ");
}

/** Decodes the common entities once, in a single pass (no double-unescaping). */
export function decodeEntities(s: string): string {
  const map: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&", "&nbsp;": " " };
  return s.replace(/&(?:lt|gt|quot|#39|amp|nbsp);/g, (m) => map[m]!);
}

/** Plain visible text; decoded entities that form tags are stripped again. */
export function htmlToText(html: string): string {
  return stripTags(decodeEntities(stripTags(html))).replace(/\s+/g, " ").trim();
}
