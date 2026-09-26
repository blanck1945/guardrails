import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig, type Rule } from "./config";
import { computeCoverage, type CoverageFileInput, type CoverageInput } from "./coverage";
import { formatCoverageDetails, formatCoverageLine, formatObservationsBlock, MAX_COVERAGE_DETAILS, MAX_COVERAGE_LINE, splitLowConfidence } from "./coverage-render";
import { buildSummary } from "./summary";

const rule = (id: string): Rule => ({ id, rule: `Rule ${id}.`, scope: ["**"], severity: "medium", status: "active" });
const file = (path: string, state: CoverageFileInput["state"] = "in-input", ignoredBy?: CoverageFileInput["ignoredBy"]): CoverageFileInput => ({ path, state, ...(ignoredBy ? { ignoredBy } : {}) });
const base = (over: Partial<CoverageInput> = {}): CoverageInput => ({
  files: [file("src/a.ts")],
  rules: [],
  engine: "agent",
  ruleChecksMode: "ask",
  checks: { ran: [], exhaustive: [], partial: [], skipped: [] },
  findings: [],
  dropped: [],
  passes: 1,
  passesFailed: 0,
  forcedWrapUp: false,
  filesOpened: [],
  steps: 3,
  ...over,
});

describe("formatCoverageLine", () => {
  it("complete run: files, ignored count and the rule split, labelled by checks and by the model", () => {
    const c = computeCoverage(
      base({
        files: [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts"), file("package-lock.json", "ignored", "default-ignore")],
        rules: [rule("c1"), rule("c2"), rule("m1"), rule("m2"), rule("m3")],
        checks: { ran: ["c1", "c2"], exhaustive: ["c1", "c2"], partial: [], skipped: [] },
        ruleChecks: [{ ruleId: "m1", verdict: "ok" }, { ruleId: "m2", verdict: "not-applicable" }, { ruleId: "m3", verdict: "ok" }],
      }),
    );
    expect(formatCoverageLine(c)).toBe("Coverage: complete · 4 of 5 changed files reviewed (1 ignored) · 5 rules in scope: 2 by checks, 3 by the model (3 with a verdict)");
  });

  it("model timed out: partial, checks only, rules not reviewed", () => {
    const c = computeCoverage(
      base({
        files: Array.from({ length: 5 }, (_, i) => file(`f${i}.ts`)),
        rules: [rule("c1"), rule("c2"), rule("m1"), rule("m2"), rule("m3")],
        checks: { ran: ["c1", "c2"], exhaustive: ["c1", "c2"], partial: [], skipped: [] },
        modelIncomplete: "timeout",
        incomplete: true,
      }),
    );
    expect(formatCoverageLine(c)).toBe("Coverage: partial (model ran out of time: checks only) · 0 of 5 changed files reviewed by the model · 5 rules in scope: 2 by checks, 3 not reviewed");
  });

  it("deep with one failed pass, over-budget files, fallback and skipped checks", () => {
    expect(formatCoverageLine(computeCoverage(base({ passes: 2, passesFailed: 1 })))).toMatch(/^Coverage: partial \(1 of 2 passes failed\) · /);
    expect(formatCoverageLine(computeCoverage(base({ files: [file("a.ts"), file("b.ts", "over-budget"), file("c.ts", "over-budget"), file("d.ts", "over-budget")] })))).toMatch(/^Coverage: partial \(3 files over the diff budget\) · 1 of 4 changed files reviewed \(3 over budget\)/);
    expect(formatCoverageLine(computeCoverage(base({ fallback: "download-failed", engine: "single", checks: { ran: [], exhaustive: [], partial: [], skipped: [{ ruleId: "x", reason: "needs-workspace" }] }, rules: [rule("x")] })))).toMatch(/^Coverage: partial \(repo download failed: single-call review; 1 check not run\)/);
    expect(formatCoverageLine(computeCoverage(base({ rules: [rule("a"), rule("b")] })))).toMatch(/^Coverage: partial \(no verdict for 2 rules\)/);
  });

  it("several reasons: the first two, then +N more", () => {
    const c = computeCoverage(base({ modelIncomplete: "error", incomplete: true, passes: 2, passesFailed: 1, forcedWrapUp: true, fallback: "download-failed" }));
    expect(c.reasons.length).toBeGreaterThan(2);
    expect(formatCoverageLine(c)).toContain(`+${c.reasons.length - 2} more)`);
  });

  it("empty PR and no rules are worded plainly", () => {
    expect(formatCoverageLine(computeCoverage(base({ files: [] })))).toBe("Coverage: complete · no changed files · no rules in scope");
  });

  it("stays within 220 characters with 300 files, 40 rules and every reason", () => {
    const files = Array.from({ length: 300 }, (_, i) => file(`src/dir${i % 9}/file-with-a-long-name-${i}.ts`, (["in-input", "ignored", "removed", "no-diff", "over-budget"] as const)[i % 5]));
    const rules = Array.from({ length: 40 }, (_, i) => rule(`rule-${i}`));
    const c = computeCoverage(base({ files, rules, modelIncomplete: "budget", incomplete: true, passes: 2, passesFailed: 2, forcedWrapUp: true, fallback: "repo-too-large", checks: { ran: [], exhaustive: [], partial: [], skipped: [{ ruleId: "rule-1", reason: "invalid-check" }] } }));
    const line = formatCoverageLine(c);
    expect(line.length).toBeLessThanOrEqual(MAX_COVERAGE_LINE);
    expect(line.startsWith("Coverage: partial")).toBe(true);
  });
});

describe("formatCoverageDetails", () => {
  const files = [file("package-lock.json", "ignored", "default-ignore"), file("src/RepositoryBadge.tsx"), file("gone.ts", "removed"), file("img.png", "no-diff"), file("big.ts", "over-budget")];
  const rules = ["colocated-tests", "one-component", "layered", "english", "deadline"].map(rule);
  const c = computeCoverage(
    base({
      files,
      rules,
      filesOpened: ["src/RepositoryBadge.tsx", "src/helper.ts"],
      checks: { ran: ["colocated-tests", "one-component", "layered", "english"], exhaustive: ["colocated-tests", "one-component"], partial: ["layered", "english"], skipped: [] },
      findings: [{ ruleId: "colocated-tests", origin: "check" }, { ruleId: "layered", origin: "check" }, { ruleId: "english", origin: "llm" }],
      ruleChecks: [{ ruleId: "layered", verdict: "ok" }, { ruleId: "deadline", verdict: "not-applicable" }],
      dropped: [{ finding: {}, reason: "duplicate" }],
    }),
  );
  const text = formatCoverageDetails(c);

  it("is a collapsed block with a files table and a rules table, tables preceded by a blank line", () => {
    expect(text.startsWith("<details><summary>What was reviewed</summary>\n\n| File | Status |")).toBe(true);
    expect(text.endsWith("</details>")).toBe(true);
    expect(text).toContain("| `package-lock.json` | ignored (default) |");
    expect(text).toContain("| `src/RepositoryBadge.tsx` | reviewed · opened by the agent |");
    expect(text).toContain("| `big.ts` | over the diff budget · checks ran |");
    expect(text).toContain("\n\n| Rule | How | Result |");
  });

  it("labels check and model apart in the rule rows", () => {
    expect(text).toContain("| `colocated-tests` | check | 1 violation |");
    expect(text).toContain("| `one-component` | check | none found |");
    expect(text).toContain("| `layered` | check + model | check: 1 violation · model: ok |");
    expect(text).toContain("| `english` | check + model | check: none found (pattern only) · model: 1 reported |");
    expect(text).toContain("| `deadline` | model | not applicable |");
    expect(text).toContain("**check** = exact result of code");
    expect(text).toContain("**model** = the model's claim; it can be wrong.");
  });

  it("states what was filtered and what the agent did", () => {
    expect(text).toContain("Filtered before publishing: 1 duplicates");
    expect(text).toContain("Agent: 3 steps, 1 file opened outside the diff.");
  });

  it("shows the reason a violated rule was not published", () => {
    const v = computeCoverage(base({ rules: [rule("r")], ruleChecks: [{ ruleId: "r", verdict: "violated" }], dropped: [{ finding: { ruleId: "r" }, reason: "low-confidence" }] }));
    expect(formatCoverageDetails(v)).toContain("| `r` | model | violated, not published (filtered: low-confidence) |");
  });

  it("never prints the path of a file that looks like a secret", () => {
    const s = computeCoverage(base({ files: [file(".env.production", "ignored", "config-ignore"), file("certs/server.pem", "ignored", "config-ignore"), file("src/a.ts")] }));
    const out = formatCoverageDetails(s);
    expect(out).not.toContain(".env.production");
    expect(out).not.toContain("server.pem");
    expect(out).toContain("(hidden: looks like a secret)");
    expect(out).toContain("`src/a.ts`");
  });

  it("stays within 8,000 characters with 300 files and 40 rules, and says how many rows were left out", () => {
    const many = Array.from({ length: 300 }, (_, i) => file(`packages/some/deeply/nested/directory/with/a/very/long/path/component-${i}.tsx`));
    const cov = computeCoverage(base({ files: many, rules: Array.from({ length: 40 }, (_, i) => rule(`a-rather-long-rule-identifier-number-${i}`)), checks: { ran: [], exhaustive: [], partial: [], skipped: [] } }));
    const out = formatCoverageDetails(cov, { shown: [{ file: "x.ts", title: "t" }], total: 1 });
    expect(out.length).toBeLessThanOrEqual(MAX_COVERAGE_DETAILS);
    expect(out).toMatch(/and \d+ more files?\./);
    expect(out).toMatch(/and \d+ more rules?\./);
  });

  it("is deterministic and lists non-reviewed files first", () => {
    expect(formatCoverageDetails(c)).toBe(text);
    const rows = text.split("\n").filter((l) => l.startsWith("| `") && l.includes("reviewed") === false);
    expect(rows.length).toBeGreaterThan(0);
    expect(text.indexOf("`big.ts`")).toBeLessThan(text.indexOf("`src/RepositoryBadge.tsx`"));
  });

  it("single mode and an empty PR", () => {
    expect(formatCoverageDetails(computeCoverage(base({ engine: "single" })))).toContain("Single call: no tools.");
    const empty = formatCoverageDetails(computeCoverage(base({ files: [] })));
    expect(empty).not.toContain("| File |");
    expect(empty).toContain("</details>");
  });
});

describe("splitLowConfidence (D-041)", () => {
  const f = (title: string, confidence: number, extra: object = {}) => ({ file: "a.ts", line: 1, title, confidence, ...extra });

  it("deep: model findings below 0.6 without a rule leave the published list", () => {
    const { published, observations } = splitLowConfidence([f("keep", 0.6), f("low", 0.59), f("low2", 0.4), f("ruled", 0.4, { ruleId: "r" }), f("check", 0.4, { origin: "check" })], "deep");
    expect(published.map((x) => x.title)).toEqual(["keep", "ruled", "check"]);
    expect(observations.total).toBe(2);
    expect(observations.shown.map((x) => x.title)).toEqual(["low", "low2"]);
  });

  it("caps the list at 5 (most confident first) and keeps the total", () => {
    const list = Array.from({ length: 8 }, (_, i) => f(`w${i}`, 0.4 + i * 0.02));
    const { observations } = splitLowConfidence(list, "deep");
    expect(observations.shown).toHaveLength(5);
    expect(observations.shown[0]!.title).toBe("w7");
    expect(observations.total).toBe(8);
    expect(formatObservationsBlock(observations)).toContain("- and 3 more");
  });

  it("other modes publish everything", () => {
    for (const mode of ["basic", "standard"] as const) {
      const { published, observations } = splitLowConfidence([f("low", 0.4)], mode);
      expect(published).toHaveLength(1);
      expect(observations.total).toBe(0);
    }
  });
});

describe("summary and config", () => {
  it("the coverage line goes after the counts and before the notes; the details go last", () => {
    const s = buildSummary({ total: 1, fromChecks: 0, fromModel: 1, notes: "a note", coverageLine: "Coverage: complete", coverageDetails: "<details>x</details>" });
    expect(s.split("\n\n")).toEqual(["**Guardrails**", "1 finding: 0 from checks, 1 from the model", "Coverage: complete", "a note", "<details>x</details>"]);
  });

  it("without coverage the summary is unchanged", () => {
    expect(buildSummary({ total: 0, fromChecks: 0, fromModel: 0 })).toBe("**Guardrails**\n\nNo issues found.");
  });

  it("config coverage defaults to details, accepts line and off, and falls back on invalid values", () => {
    expect(defaultConfig.coverage).toBe("details");
    expect(parseConfig(JSON.stringify({ coverage: "line" })).coverage).toBe("line");
    expect(parseConfig(JSON.stringify({ coverage: "off" })).coverage).toBe("off");
    expect(parseConfig(JSON.stringify({ coverage: "loud", strictness: 3 }))).toMatchObject({ coverage: "details", strictness: 3 });
  });
});
