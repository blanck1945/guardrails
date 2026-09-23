/** Lines (new-file numbering) that GitHub accepts for inline comments, from a unified patch. */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let n = 0;
  for (const l of patch.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (l.startsWith("-") || l.startsWith("\\")) continue;
    lines.add(n);
    n++;
  }
  return lines;
}
