const ZWSP = "​";
const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)*github\.com$/i;

function isAllowedUrl(url: string): boolean {
  const m = /^(?:https?:)?\/\/([^/:?#\s]+)/i.exec(url.trim());
  if (!m) return !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()); // relative ok, other schemes not
  return ALLOWED_HOST.test(m[1]!);
}

const mention = (s: string) => s.replace(/@(?!​)/g, `@${ZWSP}`);

function sanitizePlain(s: string): string {
  return mention(
    s
      // images: drop external ones entirely
      .replace(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g, (m, url: string) => (isAllowedUrl(url) ? m : ""))
      // links outside github.com: keep the text only
      .replace(/(?<!!)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g, (m, text: string, url: string) =>
        isAllowedUrl(url) ? m : text,
      )
      // raw HTML tags (img, a, script, comments): strip
      .replace(/<(\/?[a-zA-Z][^>]*|!--[\s\S]*?--)>/g, ""),
  );
}

/**
 * Makes model-written markdown safe to post on GitHub:
 * `@` -> `@​`, external images removed, links outside github.com reduced to their text,
 * raw HTML stripped, length capped. Fenced and inline code is left intact except for `@`.
 */
export function sanitizeMarkdown(text: string, maxLength = 1500): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const out = parts.map((p, i) => (i % 2 === 1 ? mention(p) : sanitizePlain(p))).join("");
  return out.length > maxLength ? out.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…" : out;
}
