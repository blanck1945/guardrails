import type { FileDiff } from "../diff";
import type { FindingV2 } from "./schema";

/** A finding of schema v1 (no evidence) or v2. */
export type Anchorable = Omit<FindingV2, "evidence"> & { evidence?: FindingV2["evidence"] | undefined };

/** Snippets shorter than this are too common to identify a line. */
export const MIN_SNIPPET_CHARS = 8;

/** Line endings, edge whitespace and inner runs of whitespace do not matter; accents are compared composed (NFC). */
const norm = (s: string): string => s.replace(/\r/g, "").normalize("NFC").replace(/\s+/g, " ").trim();

const QUOTED = [/`([^`\n]+)`/g, /"([^"\n]+)"/g, /'([^'\n]+)'/g, /“([^”\n]+)”/g];

/** Backtick or quoted fragments of a text, in order of appearance, long enough to be identifying. */
export function quotedSnippets(text: string): string[] {
  const out: string[] = [];
  for (const re of QUOTED) for (const m of text.matchAll(re)) out.push(norm(m[1] ?? ""));
  return out.filter((s) => s.length >= MIN_SNIPPET_CHARS);
}

/** Snippets that may quote the offending code: evidence notes first, then the title, then the body. */
function candidateSnippets(f: Anchorable): string[] {
  const sources = [...(f.evidence ?? []).filter((e) => e.file === f.file).map((e) => e.note), f.title, f.body];
  return [...new Set(sources.flatMap(quotedSnippets))];
}

/**
 * Moves a finding to the added line that contains the text it quotes (evidence notes, title, body), instead of
 * trusting the model's line number. Only lines added by the diff and accepted for inline comments are chosen.
 * Several matching lines: the model's own line if it is one of them, otherwise the first. No match: unchanged.
 */
export function snapToQuotedLine<T extends Anchorable>(finding: T, files: readonly FileDiff[]): T {
  const file = files.find((d) => d.path === finding.file);
  if (!file) return finding;
  const commentable = new Set(file.commentableLines);
  const added: { line: number; text: string }[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type === "add" && l.newLine !== null && commentable.has(l.newLine)) added.push({ line: l.newLine, text: norm(l.content) });
    }
  }
  for (const snippet of candidateSnippets(finding)) {
    const hits = added.filter((a) => a.text.includes(snippet)).map((a) => a.line);
    if (!hits.length) continue;
    const line = hits.includes(finding.line) ? finding.line : hits[0]!;
    if (line === finding.line) return finding;
    const { startLine: _drop, ...rest } = finding;
    void _drop;
    return { ...rest, line } as T;
  }
  return finding;
}

/** `snapToQuotedLine` over a list, given the unified diff already parsed. */
export function snapAnchors<T extends Anchorable>(findings: readonly T[], files: readonly FileDiff[]): T[] {
  return findings.map((f) => snapToQuotedLine(f, files));
}
