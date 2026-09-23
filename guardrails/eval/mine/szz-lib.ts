/** Pure helpers for the simplified SZZ (no I/O), unit-tested in szz.test.ts. */

export type Range = [number, number];

/**
 * Old-side line ranges touched by `git diff -U0` (deleted or modified lines), per file.
 * Pure additions (old count 0) have nothing to blame and are skipped.
 * Files that are new (`--- /dev/null`) or deleted are skipped.
 */
export function parseRemovedRanges(diff: string): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  let file: string | null = null;
  let oldIsNull = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      oldIsNull = line.startsWith("--- /dev/null");
      file = null;
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = oldIsNull || p === "/dev/null" ? null : p.replace(/^b\//, "");
    } else if (line.startsWith("@@") && file) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count === 0) continue;
      const list = out.get(file) ?? [];
      list.push([start, start + count - 1]);
      out.set(file, list);
    }
  }
  return out;
}

export interface BlamedLine {
  commit: string;
  /** Line number in the introducing commit's version of the file. */
  origLine: number;
  /** File name in the introducing commit (follows renames). */
  filename: string;
  committerTime: number;
  boundary: boolean;
  content: string;
}

/** Parses `git blame --line-porcelain` output. */
export function parseBlamePorcelain(out: string): BlamedLine[] {
  const res: BlamedLine[] = [];
  let cur: Partial<BlamedLine> | null = null;
  for (const line of out.split("\n")) {
    if (cur && line.startsWith("\t")) {
      res.push({ ...(cur as BlamedLine), content: line.slice(1) });
      cur = null;
      continue;
    }
    const h = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
    if (h && !cur) {
      cur = { commit: h[1]!, origLine: Number(h[2]), boundary: false, filename: "", committerTime: 0 };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("filename ")) cur.filename = line.slice(9);
    else if (line.startsWith("committer-time ")) cur.committerTime = Number(line.slice(15));
    else if (line === "boundary") cur.boundary = true;
  }
  return res;
}

const COMMENT_PREFIXES = ["//", "#", "*", "/*", "*/"];

/** Blank and comment-only lines are not meaningful bug lines. */
export function isMeaningfulLine(content: string): boolean {
  const t = content.trim();
  return t.length > 0 && !COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

/** Collapses sorted-or-not line numbers into inclusive ranges. */
export function toRanges(lines: number[]): Range[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Range[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

const FIX_TITLE = /^\s*(?:\w+(?:\([^)]*\))?!?:\s*)?(?:fix(?:es|ed)?|bug\s*fix|hotfix)\b/i;

/** A PR looks like a bug fix by title ("fix: ...", "Fix ...") or by the repo's bug label. */
export function isFixPr(title: string, labels: string[], bugLabel?: string): boolean {
  if (bugLabel && labels.some((l) => l.toLowerCase() === bugLabel.toLowerCase())) return true;
  return FIX_TITLE.test(title);
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|docs?|examples?|benchmarks?|scripts?)\//i;
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|(^|\/)conftest\.py$/i;
const LANG_EXT: Record<string, string[]> = {
  ts: [".ts", ".tsx", ".mts", ".cts"],
  js: [".js", ".jsx", ".mjs", ".cjs"],
  py: [".py"],
};

/** Source file worth blaming: right language, not a test/doc/example. */
export function isSourceFile(file: string, language: "ts" | "js" | "py"): boolean {
  const exts = language === "ts" ? [...LANG_EXT.ts!, ...LANG_EXT.js!] : LANG_EXT[language]!;
  if (!exts.some((e) => file.endsWith(e))) return false;
  if (file.endsWith(".d.ts")) return false;
  return !TEST_PATH.test(file) && !TEST_FILE.test(file);
}

/** Picks the commit that owns the most blamed lines. Ties: the most recent commit. */
export function pickIntroducingCommit(
  lines: { commit: string; committerTime: number }[],
): { commit: string; count: number; committerTime: number } | null {
  const by = new Map<string, { count: number; committerTime: number }>();
  for (const l of lines) {
    const e = by.get(l.commit) ?? { count: 0, committerTime: l.committerTime };
    e.count++;
    by.set(l.commit, e);
  }
  let best: { commit: string; count: number; committerTime: number } | null = null;
  for (const [commit, e] of by) {
    if (!best || e.count > best.count || (e.count === best.count && e.committerTime > best.committerTime)) {
      best = { commit, ...e };
    }
  }
  return best;
}
