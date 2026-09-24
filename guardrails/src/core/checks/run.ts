import picomatch from "picomatch";
import type { Rule } from "../config";
import type { FileDiff } from "../diff";
import { globMatchesFile } from "../rules/select";
import { ruleType } from "../rules/merge";
import type { Finding } from "../types";
import type { Workspace } from "../workspace";
import { LEXABLE, maskLines, type Zone } from "./lexer";
import { hasLogic } from "./logic";
import { parseCheck } from "./spec";

/** A rule's check that could not run, with a stable reason. */
export interface CheckSkip {
  ruleId: string;
  reason: "invalid-check" | "needs-workspace" | "read-failed";
}

export interface CheckOutcome {
  /** Findings with `origin: "check"`, confidence 1, sorted by file, line, rule. */
  findings: Finding[];
  /** Ids of the rules whose check ran completely (the model is told not to re-check these). */
  ran: string[];
  skipped: CheckSkip[];
}

export interface RunChecksInput {
  rules: readonly Rule[];
  /** Parsed diff of the PR (`parseUnifiedDiff`). */
  files: readonly FileDiff[];
  /** Head tree access. Without it the checks that need file contents or the tree are skipped. */
  workspace?: Workspace | undefined;
}

/** A single rule never floods a review with more than this many check findings. */
export const MAX_FINDINGS_PER_RULE = 30;

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_EXTS = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"];

const inScope = (rule: Rule, path: string): boolean =>
  rule.scope.some((g) => globMatchesFile(g, path)) && !(rule.exclude ?? []).some((g) => globMatchesFile(g, path));

const firstSentence = (s: string): string => {
  const one = s.trim().split("\n")[0]!.trim();
  return one.length > 200 ? `${one.slice(0, 197)}...` : one;
};

/** Line to attach a file-level finding to: prefer a line GitHub can comment on (an added one). */
function anchorLine(f: FileDiff, preferred?: number): number {
  if (preferred !== undefined && f.commentableLines.includes(preferred)) return preferred;
  return f.addedLines[0] ?? f.commentableLines[0] ?? preferred ?? 1;
}

const addedLinesOf = (f: FileDiff): { line: number; text: string }[] =>
  f.hunks.flatMap((h) => h.lines.flatMap((l) => (l.type === "add" && l.newLine !== null ? [{ line: l.newLine, text: l.content }] : [])));

const IMPORT_RES = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Import/require specifiers found on one line of source. */
export function importSpecifiers(line: string): string[] {
  const out: string[] = [];
  for (const re of IMPORT_RES) for (const m of line.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Glob when the pattern has `* ? { }`, substring otherwise. Relative prefixes (`../`) are ignored for globs. */
export function importMatches(pattern: string, specifier: string): boolean {
  if (!/[*?{}]/.test(pattern)) return specifier.includes(pattern);
  const stripped = specifier.replace(/^(?:\.{1,2}\/)+/, "");
  const isMatch = picomatch(pattern, { dot: true });
  return isMatch(specifier) || isMatch(stripped) || (pattern.startsWith("**/") && isMatch(`x/${stripped}`));
}

/**
 * Runs the mechanical checks of the given rules (only `active` ones with a valid `check`). Deterministic and
 * model-free: same diff and same head tree give the same findings.
 */
export async function runChecks({ rules, files, workspace }: RunChecksInput): Promise<CheckOutcome> {
  const findings: Finding[] = [];
  const ran: string[] = [];
  const skipped: CheckSkip[] = [];
  const live = files.filter((f) => f.status !== "deleted" && !f.binary);
  let tree: Set<string> | undefined;
  const headTree = async (): Promise<Set<string>> => {
    tree ??= new Set((await workspace!.listFiles({ ref: "head", limit: 50_000 })).files);
    return tree;
  };
  /** Whole head file (readFile serves at most 300 lines / 24k chars per call). */
  const headText = async (path: string): Promise<string | null> => {
    try {
      const lines: string[] = [];
      let start = 1;
      for (let calls = 0; calls < 400; calls++) {
        const r = await workspace!.readFile({ path, ref: "head", startLine: start, endLine: start + 299 });
        if (r.endLine < start) return null; // a single line above the size cap: not readable as text
        lines.push(...r.content.split("\n").map((l) => l.replace(/^\d+\t/, "")));
        if (r.endLine >= r.totalLines) return lines.join("\n");
        start = r.endLine + 1;
      }
      return null;
    } catch {
      return null;
    }
  };

  for (const rule of rules) {
    if (rule.status !== "active" || !rule.check) continue;
    const parsed = parseCheck(rule.check);
    if (!parsed.ok) {
      skipped.push({ ruleId: rule.id, reason: "invalid-check" });
      continue;
    }
    const spec = parsed.spec;
    const scoped = live.filter((f) => inScope(rule, f.path));
    const out: Finding[] = [];
    const make = (file: string, line: number, title: string, detail: string): Finding => ({
      file,
      line,
      type: ruleType(rule),
      severity: rule.severity,
      confidence: 1,
      title: title.slice(0, 120),
      body: `${detail} Rule \`${rule.id}\`: ${firstSentence(rule.rule)}`.slice(0, 1500),
      ruleId: rule.id,
      origin: "check",
    });
    const needsWorkspace = spec.kind === "max-lines" || spec.kind === "colocated-test" || (spec.kind === "forbid-pattern" && spec.only);
    if (needsWorkspace && !workspace) {
      skipped.push({ ruleId: rule.id, reason: "needs-workspace" });
      continue;
    }
    let readFailed = false;

    if (spec.kind === "max-lines") {
      for (const f of scoped) {
        let total: number;
        try {
          total = (await workspace!.readFile({ path: f.path, ref: "head", startLine: 1, endLine: 1 })).totalLines;
        } catch {
          readFailed = true;
          continue;
        }
        if (total > spec.max) {
          out.push(make(f.path, anchorLine(f, spec.max + 1), `File has ${total} lines (max ${spec.max})`, `\`${f.path}\` has ${total} lines; the limit is ${spec.max}.`));
        }
      }
    } else if (spec.kind === "colocated-test") {
      const existing = await headTree();
      const inDiff = new Set(files.map((f) => f.path));
      for (const f of scoped) {
        if (!SOURCE_EXT.test(f.path) || TEST_FILE.test(f.path) || /\.d\.[cm]?ts$/i.test(f.path)) continue;
        const m = /^(.*\/|)([^/]+?)\.([cm]?[jt]sx?)$/i.exec(f.path)!;
        const dir = m[1]!;
        const name = m[2]!;
        const siblings = TEST_EXTS.flatMap((e) => [`${dir}${name}.test.${e}`, `${dir}${name}.spec.${e}`]);
        if (siblings.some((s) => existing.has(s) || inDiff.has(s))) continue;
        const text = await headText(f.path);
        if (text === null) {
          readFailed = true;
          continue;
        }
        if (!hasLogic(text)) continue;
        out.push(make(f.path, anchorLine(f), `No colocated test for ${name}.${m[3]}`, `\`${f.path}\` has no \`${name}.test.*\` or \`${name}.spec.*\` next to it.`));
      }
    } else if (spec.kind === "forbid-import") {
      for (const f of scoped) {
        if (!LEXABLE.test(f.path)) continue;
        for (const l of addedLinesOf(f)) {
          const hit = importSpecifiers(l.text).find((s) => importMatches(spec.pattern, s));
          if (hit !== undefined) {
            out.push(make(f.path, l.line, `Forbidden import "${hit}"`, `\`${f.path}\` imports "${hit}", which matches the forbidden pattern \`${spec.pattern}\`.`));
          }
        }
      }
    } else {
      const re = new RegExp(spec.source, spec.flags);
      const zone: Zone | undefined = spec.only === "comments" ? "comment" : spec.only === "strings" ? "string" : spec.only;
      for (const f of scoped) {
        let masked: string[] | undefined;
        if (zone) {
          if (!LEXABLE.test(f.path)) continue;
          const text = await headText(f.path);
          if (text === null) {
            readFailed = true;
            continue;
          }
          masked = maskLines(text, zone);
        }
        for (const l of addedLinesOf(f)) {
          const subject = masked ? (masked[l.line - 1] ?? "") : l.text;
          const m = re.exec(subject);
          if (m && m[0] !== "") {
            const shown = m[0].length > 30 ? `${m[0].slice(0, 27)}...` : m[0];
            out.push(make(f.path, l.line, `Forbidden pattern "${shown}"`, `Line ${l.line} of \`${f.path}\` matches the forbidden pattern \`${spec.source}\`${spec.only ? ` (inside ${spec.only})` : ""}.`));
          }
        }
      }
    }

    if (readFailed) skipped.push({ ruleId: rule.id, reason: "read-failed" });
    else ran.push(rule.id);
    findings.push(...out.slice(0, MAX_FINDINGS_PER_RULE));
  }

  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.ruleId ?? "").localeCompare(b.ruleId ?? "")));
  return { findings, ran, skipped };
}
