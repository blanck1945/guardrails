import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff";
import { dedupe, mergeAcrossPasses, quotedSnippets, snapAnchors, snapToQuotedLine, type FindingV2 } from ".";

const FILE = "src/useReminders.ts";

const f = (over: Partial<FindingV2> = {}): FindingV2 => ({
  file: FILE,
  line: 19,
  type: "logic",
  severity: "medium",
  confidence: 0.7,
  title: "Business days reimplemented in the hook",
  body: "Use the domain helper.",
  ruleId: "deadline-logic-centralized",
  evidence: [{ file: FILE, startLine: over.line ?? 19, endLine: over.line ?? 19, note: "loop" }],
  ...over,
});

describe("mergeAcrossPasses", () => {
  it("PR #5 shape: same rule and file, 7 lines apart, different title wording -> one finding with Also at", () => {
    const a = f({ line: 19, title: "Business day logic duplicated in useReminders" });
    const b = f({ line: 26, title: "Deadline calculation reimplemented instead of the domain helper", confidence: 0.8 });
    const { findings, merged } = mergeAcrossPasses([[a], [b]]);
    expect(merged).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(26); // the more confident version is kept
    expect(findings[0]!.body).toContain("Also at line 19.");
    expect(findings[0]!.confidence).toBeCloseTo(0.9);
  });

  it("matches one to one: a second finding of the same pass is not folded in", () => {
    const { findings } = mergeAcrossPasses([[f({ line: 19 }), f({ line: 40, title: "x y z" })], [f({ line: 26, confidence: 0.9 })]]);
    expect(findings).toHaveLength(2);
  });

  it("keeps two genuinely different problems under one rule separate when both passes report both", () => {
    const p1a = f({ line: 10, title: "Business days reimplemented" });
    const p2a = f({ line: 40, title: "Holiday list hardcoded in hook" });
    const p1b = f({ line: 11, title: "Business days reimplemented in hook" });
    const p2b = f({ line: 41, title: "Hardcoded holiday list" });
    const { findings, merged } = mergeAcrossPasses([[p1a, p2a], [p1b, p2b]]);
    expect(findings).toHaveLength(2);
    expect(merged).toBe(2);
    // each pair merged with its own counterpart (the one with the closer line and the similar title)
    expect(findings[0]!.body).toMatch(/Also at line (10|11)\./);
    expect(findings[1]!.body).toMatch(/Also at line (40|41)\./);
  });

  it("never merges findings of the same pass, nor different files", () => {
    expect(mergeAcrossPasses([[f({ line: 1 }), f({ line: 30 })], []]).findings).toHaveLength(2);
    expect(mergeAcrossPasses([[f()], [f({ file: "src/other.ts" })]]).findings).toHaveLength(2);
  });

  it("without a rule, merges by title similarity regardless of distance; different titles stay apart", () => {
    const a = f({ ruleId: undefined, line: 5, title: "Spanish comment in code" });
    const same = f({ ruleId: undefined, line: 50, title: "Spanish comment in code file" });
    const other = f({ ruleId: undefined, line: 50, title: "Unused import left behind" });
    expect(mergeAcrossPasses([[a], [same]]).findings).toHaveLength(1);
    expect(mergeAcrossPasses([[a], [other]]).findings).toHaveLength(2);
  });

  it("higher severity wins over higher confidence", () => {
    const { findings } = mergeAcrossPasses([[f({ severity: "high", confidence: 0.5, line: 3 })], [f({ severity: "low", confidence: 0.99, line: 9 })]]);
    expect(findings[0]).toMatchObject({ severity: "high", line: 3 });
  });

  it("is idempotent", () => {
    const once = mergeAcrossPasses([[f({ line: 19 })], [f({ line: 26 })]]).findings;
    const twice = mergeAcrossPasses([once]);
    expect(twice.findings).toEqual(once);
    expect(twice.merged).toBe(0);
    expect(dedupe(once)).toEqual(once);
    const again = mergeAcrossPasses([once, []]).findings;
    expect(again[0]!.body.match(/Also at/g)).toHaveLength(1);
  });
});

const DIFF = [
  `--- a/${FILE}`,
  `+++ b/${FILE}`,
  "@@ -1,3 +1,8 @@",
  " import x from 'x';",
  "+// Recordatorio de vencimientos próximos",
  "+function addBusinessDays(d: Date, n: number) {",
  "+  const days = n;",
  "+  const days2 = n;",
  " export const a = 1;",
  "+  return days + days2;",
  " export const b = 2;",
  "",
].join("\n");

describe("snapToQuotedLine", () => {
  const files = parseUnifiedDiff(DIFF);
  const note = (text: string) => [{ file: FILE, startLine: 1, endLine: 1, note: text }];
  const base = f({ line: 2, evidence: note("see `function addBusinessDays(`") });

  it("snaps to the added line that contains the evidence snippet", () => {
    expect(snapToQuotedLine(base, files).line).toBe(3);
  });

  it("several matches: keeps the model's line when it is one of them, otherwise the first", () => {
    const ev = note("`const days`");
    expect(snapToQuotedLine(f({ line: 5, evidence: ev }), files).line).toBe(5);
    expect(snapToQuotedLine(f({ line: 1, evidence: ev }), files).line).toBe(4);
  });

  it("no match: keeps the model's line and startLine", () => {
    const out = snapToQuotedLine(f({ line: 7, startLine: 6, evidence: note("`does not exist here`") }), files);
    expect(out).toMatchObject({ line: 7, startLine: 6 });
  });

  it("never anchors to a context (unchanged) line even if it matches", () => {
    const out = snapToQuotedLine(f({ line: 8, body: "look at `export const a = 1;`", evidence: note("x") }), files);
    expect(out.line).toBe(8);
  });

  it("uses quoted text from the body and the title, and matches accented text", () => {
    const out = snapToQuotedLine(f({ line: 1, body: 'The comment "Recordatorio de vencimientos próximos" is Spanish.' }), files);
    expect(out.line).toBe(2);
    expect(snapToQuotedLine(f({ line: 1, title: "Use of `addBusinessDays`" }), files).line).toBe(3);
  });

  it("ignores snippets shorter than 8 characters and other files", () => {
    expect(snapToQuotedLine(f({ line: 1, body: "the `days` var" }), files).line).toBe(1);
    expect(snapToQuotedLine(f({ file: "src/nope.ts", line: 1, body: "`function addBusinessDays(`" }), files).line).toBe(1);
  });

  it("normalises CRLF and drops startLine when it moves", () => {
    // file content with CRLF: diff rows are split on LF, so each content row keeps a trailing CR
    const crlf = parseUnifiedDiff(DIFF.replace(/^((?:\+(?!\+\+)| ).*)$/gm, "$1\r"));
    const out = snapToQuotedLine({ ...base, line: 1, startLine: 1 }, crlf);
    expect(out.line).toBe(3);
    expect(out.startLine).toBeUndefined();
  });

  it("snapAnchors maps a list", () => {
    expect(snapAnchors([base, f({ line: 9 })], files).map((x) => x.line)).toEqual([3, 9]);
  });

  it("quotedSnippets extracts backtick and quoted text of enough length", () => {
    expect(quotedSnippets('a `some code here` b "quoted text!" `short`')).toEqual(["some code here", "quoted text!"]);
  });
});

// v0.7.3: anchors respect the evidence ranges of the model
const HOOK = "src/hooks/useReminders.ts";
const hookLines = (): string[] => {
  const rows: string[] = [];
  for (let n = 1; n <= 40; n++) {
    if (n === 9) rows.push("  businessDaysLeft: number;");
    else if (n === 20) rows.push("// Recordatorio de vencimientos");
    else if (n === 21) rows.push("function businessDaysBetween(a: Date, b: Date) {");
    else if (n === 22) rows.push("  let businessDays = 0;");
    else if (n === 33) rows.push("}");
    else rows.push(`const filler${n} = ${n};`);
  }
  return rows;
};
const hookDiff = (rows: string[], contextLines: number[] = []): string =>
  [
    `--- a/${HOOK}`,
    `+++ b/${HOOK}`,
    `@@ -1,${rows.length} +1,${rows.length} @@`,
    ...rows.map((r, i) => (contextLines.includes(i + 1) ? ` ${r}` : `+${r}`)),
    "",
  ].join("\n");
const ev = (startLine: number, endLine: number, note = "x", file = HOOK) => ({ file, startLine, endLine, note });
const hf = (over: Partial<FindingV2> = {}): FindingV2 => ({
  file: HOOK,
  line: 9,
  type: "logic",
  severity: "medium",
  confidence: 0.8,
  title: "Business day logic reimplemented in the hook",
  body: "Use the domain helper for `businessDays` counting.",
  ruleId: "deadline-logic-centralized",
  evidence: [ev(21, 33, "business day loop"), ev(20, 35)],
  ...over,
});

describe("snapToQuotedLine with evidence ranges (v0.7.3)", () => {
  const files = parseUnifiedDiff(hookDiff(hookLines()));

  it("regression: an interface field on line 9 is never chosen when the ranges point to the function", () => {
    const out = snapToQuotedLine(hf({ line: 9 }), files);
    expect(out.line).toBeGreaterThanOrEqual(21);
    expect(out.line).toBeLessThanOrEqual(33);
    expect(out.line).not.toBe(9);
    expect(out.startLine).toBeUndefined();
  });

  it("snippet match inside the range is kept", () => {
    expect(snapToQuotedLine(hf({ line: 22, body: "see `let businessDays = 0;`" }), files).line).toBe(22);
  });

  it("several matches, one inside the range: the one inside", () => {
    expect(snapToQuotedLine(hf({ line: 1, title: "x", body: "see `businessDays`" }), files).line).toBe(21);
  });

  it("no snippet match: first added line of the best range (note shares words with the title)", () => {
    const out = snapToQuotedLine(
      hf({ line: 9, body: "nothing quoted", title: "Reminder heading text", evidence: [ev(21, 33, "business day loop"), ev(25, 30, "reminder heading text")] }),
      files,
    );
    expect(out.line).toBe(25);
  });

  it("no snippet match and tied ranges: the first range", () => {
    expect(snapToQuotedLine(hf({ line: 9, body: "nothing quoted", title: "zzz", evidence: [ev(24, 30), ev(21, 33)] }), files).line).toBe(24);
  });

  it("model line already inside a range is kept when nothing matches", () => {
    expect(snapToQuotedLine(hf({ line: 27, body: "nothing quoted" }), files).line).toBe(27);
  });

  it("non-added lines are never chosen", () => {
    const ctx = parseUnifiedDiff(hookDiff(hookLines(), [21, 22, 23]));
    const out = snapToQuotedLine(hf({ line: 9, body: "nothing quoted", evidence: [ev(21, 33)] }), ctx);
    expect(out.line).toBe(24);
    const allCtx = parseUnifiedDiff(hookDiff(hookLines(), Array.from({ length: 20 }, (_, i) => 20 + i)));
    // no added line in any range: old behaviour (snippet match anywhere, else unchanged)
    expect(snapToQuotedLine(hf({ line: 9, body: "nothing quoted" }), allCtx).line).toBe(9);
    expect(snapToQuotedLine(hf({ line: 1, body: "see `businessDaysLeft`" }), allCtx).line).toBe(9);
  });

  it("without ranges the old behaviour is unchanged", () => {
    expect(snapToQuotedLine(hf({ line: 30, evidence: [] }), files).line).toBe(9);
    expect(snapToQuotedLine(hf({ line: 21, evidence: [], body: "see `businessDays`" }), files).line).toBe(21);
  });

  it("ranges of other files are ignored", () => {
    const out = snapToQuotedLine(hf({ line: 30, evidence: [ev(21, 33, "x", "src/other.ts")] }), files);
    expect(out.line).toBe(9);
  });

  it("CRLF and accents still work inside ranges", () => {
    const crlf = parseUnifiedDiff(hookDiff(hookLines()).replace(/^(\+(?!\+\+).*)$/gm, "$1\r"));
    expect(snapToQuotedLine(hf({ line: 1, body: 'The comment "Recordatorio de vencimientos" is Spanish.', evidence: [ev(20, 21)] }), crlf).line).toBe(20);
    expect(snapToQuotedLine(hf({ line: 9 }), crlf).line).toBeGreaterThanOrEqual(21);
  });
});

describe("mergeAcrossPasses anchors and body cap (v0.7.3)", () => {
  it("prefers the candidate whose line is inside an evidence range, even with lower severity", () => {
    const off = hf({ line: 9, severity: "high", confidence: 0.9, evidence: [ev(21, 33, "loop")] });
    const right = hf({ line: 21, severity: "low", confidence: 0.5, evidence: [ev(21, 33, "loop")] });
    expect(mergeAcrossPasses([[off], [right]]).findings[0]!.line).toBe(21);
    expect(mergeAcrossPasses([[right], [off]]).findings[0]!.line).toBe(21);
  });

  it("falls back to severity then confidence when both are inside ranges", () => {
    const a = hf({ line: 21, severity: "high", evidence: [ev(20, 33)] });
    const b = hf({ line: 25, severity: "low", evidence: [ev(20, 33)] });
    expect(mergeAcrossPasses([[b], [a]]).findings[0]!.line).toBe(21);
  });

  it("30 extra locations become 6 plus 'and 24 more'", () => {
    const passes = Array.from({ length: 31 }, (_, i) => [hf({ line: 200 + i, evidence: [] })]);
    const { findings } = mergeAcrossPasses(passes);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toMatch(/Also at lines (\d+, ){5}\d+ and 24 more\.$/);
    expect(mergeAcrossPasses([findings]).findings[0]!.body).toBe(findings[0]!.body);
  });

  it("truncates an over-long body but keeps the Also at line; idempotent; never above 1500", () => {
    const long = "x".repeat(1500);
    const { findings } = mergeAcrossPasses([[hf({ line: 1, evidence: [], body: long })], [hf({ line: 50, evidence: [], body: long })]]);
    const body = findings[0]!.body;
    expect(body.length).toBeLessThanOrEqual(1500);
    expect(body).toMatch(/…\n\nAlso at line \d+\.$/);
    expect(mergeAcrossPasses([findings]).findings[0]!.body).toBe(body);
  });
});
