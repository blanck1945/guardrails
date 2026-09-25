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
  evidence: [{ file: FILE, startLine: 19, endLine: 19, note: "loop" }],
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
