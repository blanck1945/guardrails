import type { Rule } from "../config";

export type RuleStatus = Rule["status"];
export type RuleSeverity = Rule["severity"];

export interface RulesMdError {
  /** 1-based line number in the markdown file. */
  line: number;
  /** Rule id when it could be determined. */
  id?: string;
  message: string;
}

export interface ParsedRulesMd {
  rules: Rule[];
  errors: RulesMdError[];
  /** Text before the first `## ` heading (user comments); preserved on serialize. */
  preamble: string;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADER_LINE = /^(scope|severity|source|status)\s*:\s*(.*)$/i;
const FENCE = /^\s{0,3}(```+|~~~+)/;
const SEVERITIES = ["low", "medium", "high"] as const;
const STATUSES = ["active", "suggested", "disabled"] as const;

/** Splits on commas that are not inside `{...}` (so `*.{ts,tsx}` stays whole). */
export function splitGlobs(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Parses `.guardrails/rules.md`. Never throws: an invalid rule is reported in `errors`
 * (with its line number) and skipped; the others are kept.
 *
 * Format: one block per rule, `## <kebab-id>`, then optional `key: value` lines
 * (scope, severity, source, status), a blank line, then the free-form natural-language body.
 * `## ` lines inside fenced code blocks are part of the body.
 */
export function parseRulesMd(text: string): ParsedRulesMd {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const rules: Rule[] = [];
  const errors: RulesMdError[] = [];
  const seen = new Set<string>();

  // 1. Split into blocks at `## ` headings outside code fences.
  type Block = { line: number; heading: string; lines: string[] };
  const preambleLines: string[] = [];
  const blocks: Block[] = [];
  let fence: string | null = null;
  lines.forEach((raw, i) => {
    const f = FENCE.exec(raw);
    if (f) {
      const mark = f[1]![0]!;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
    }
    const h = fence === null && !raw.startsWith("###") ? /^##\s+(.*?)\s*$/.exec(raw) : null;
    if (h) blocks.push({ line: i + 1, heading: h[1]!, lines: [] });
    else if (blocks.length) blocks[blocks.length - 1]!.lines.push(raw);
    else preambleLines.push(raw);
  });

  // 2. Parse each block independently.
  for (const b of blocks) {
    const id = b.heading;
    const err = (message: string, line = b.line) => errors.push({ line, id, message });
    if (!KEBAB.test(id)) {
      err(`invalid rule id "${id}": use kebab-case (lowercase letters, digits, hyphens)`);
      continue;
    }
    if (seen.has(id)) {
      err(`duplicate rule id "${id}" (first definition wins)`);
      continue;
    }

    const meta: Record<string, { value: string; line: number }> = {};
    let idx = 0;
    while (idx < b.lines.length) {
      const m = HEADER_LINE.exec(b.lines[idx]!.trim());
      if (!m) break;
      meta[m[1]!.toLowerCase()] = { value: m[2]!.trim(), line: b.line + 1 + idx };
      idx++;
    }
    const body = b.lines.slice(idx).join("\n").trim();

    let ok = true;
    const bad = (message: string, line: number) => {
      err(message, line);
      ok = false;
    };
    let severity: RuleSeverity = "medium";
    if (meta.severity) {
      const v = meta.severity.value.toLowerCase();
      if ((SEVERITIES as readonly string[]).includes(v)) severity = v as RuleSeverity;
      else bad(`invalid severity "${meta.severity.value}" (expected low, medium or high)`, meta.severity.line);
    }
    let status: RuleStatus = "active";
    if (meta.status) {
      const v = meta.status.value.toLowerCase();
      if ((STATUSES as readonly string[]).includes(v)) status = v as RuleStatus;
      else bad(`invalid status "${meta.status.value}" (expected active, suggested or disabled)`, meta.status.line);
    }
    if (!body) bad("rule has no body text", b.line);
    if (!ok) continue;

    const scope = meta.scope ? splitGlobs(meta.scope.value) : [];
    const rule: Rule = { id, rule: body, scope: scope.length ? scope : ["**"], severity, status };
    if (meta.source?.value) rule.source = meta.source.value;
    seen.add(id);
    rules.push(rule);
  }

  return { rules, errors, preamble: preambleLines.join("\n").replace(/^\n+|\s+$/g, "") };
}

/**
 * Inverse of `parseRulesMd`: parse(serialize(rules)) yields the same rules. Every field is
 * written explicitly so the file stays readable and edits are easy to diff.
 */
export function serializeRulesMd(rules: readonly Rule[], opts: { preamble?: string } = {}): string {
  const blocks = rules.map((r) => {
    const head = [`## ${r.id}`, `scope: ${(r.scope.length ? r.scope : ["**"]).join(", ")}`, `severity: ${r.severity}`];
    if (r.source) head.push(`source: ${r.source}`);
    head.push(`status: ${r.status}`);
    return `${head.join("\n")}\n\n${r.rule.trim()}`;
  });
  const pre = opts.preamble?.trim();
  return [pre, ...blocks].filter(Boolean).join("\n\n") + "\n";
}
