import { describe, it, expect } from "vitest";
import { capFindings, capFor, collapseByLocation, type LimitableFinding } from "./limits";

const rules = [
  { id: "layered", severity: "high" as const, status: "active" },
  { id: "tests", severity: "medium" as const, status: "active" },
  { id: "off", severity: "high" as const, status: "suggested" },
];
type F = LimitableFinding & { title: string };
const f = (title: string, o: Partial<F> = {}): F => ({ file: "a.ts", line: 12, severity: "medium", confidence: 0.8, title, ...o });

describe("collapseByLocation", () => {
  it("merges same-line findings of the same rule, keeping the best", () => {
    const r = collapseByLocation([f("a", { ruleId: "tests", confidence: 0.6 }), f("b", { ruleId: "tests", confidence: 0.9 })], rules);
    expect(r.kept.map((x) => x.title)).toEqual(["b"]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });

  it("keeps at most 2 per (file, line) and prefers rule findings over generic ones", () => {
    const list = [
      f("generic-1", { severity: "high", confidence: 1 }),
      f("generic-2", { severity: "high", confidence: 0.95 }),
      f("rule", { ruleId: "tests", severity: "low", confidence: 0.5 }),
    ];
    const r = collapseByLocation(list, rules);
    expect(r.kept.map((x) => x.title)).toEqual(["generic-1", "rule"]);
    expect(r.dropped.map((d) => d.finding.title)).toEqual(["generic-2"]);
  });

  it("does not touch findings on different lines or files", () => {
    const list = [f("a"), f("b", { line: 13 }), f("c", { file: "b.ts" }), f("d", { line: 14 })];
    expect(collapseByLocation(list, rules).kept).toHaveLength(4);
  });

  it("does not treat an unknown or inactive rule as a rule citation", () => {
    const list = [f("g", { severity: "high" }), f("inactive", { ruleId: "off", severity: "low", confidence: 0.3 }), f("g2", { severity: "medium" })];
    expect(collapseByLocation(list, rules).kept.map((x) => x.title)).toEqual(["g", "g2"]);
  });
});

describe("capFindings", () => {
  it("uses caps 3/5/8 for strictness 1/2/3", () => {
    expect([1, 2, 3].map(capFor)).toEqual([3, 5, 8]);
  });

  it("keeps the best by severity x confidence and reports the rest as over-cap", () => {
    const list = [
      f("low", { severity: "low", confidence: 1, line: 1 }),
      f("high", { severity: "high", confidence: 0.9, line: 2 }),
      f("med-sure", { severity: "medium", confidence: 0.95, line: 3 }),
      f("med-unsure", { severity: "medium", confidence: 0.5, line: 4 }),
    ];
    const r = capFindings(list, rules, 2);
    expect(r.kept.map((x) => x.title)).toEqual(["high", "med-sure"]); // input order preserved
    expect(r.dropped.map((d) => [d.finding.title, d.reason])).toEqual([["low", "over-cap"], ["med-unsure", "over-cap"]]);
  });

  it("never drops a finding that cites an active high-severity rule", () => {
    const list = [
      f("g1", { severity: "high", confidence: 1, line: 1 }),
      f("g2", { severity: "high", confidence: 1, line: 2 }),
      f("rule-low-conf", { ruleId: "layered", severity: "low", confidence: 0.4, line: 3 }),
    ];
    const r = capFindings(list, rules, 1);
    expect(r.kept.map((x) => x.title)).toEqual(["rule-low-conf"]);
    expect(r.dropped).toHaveLength(2);
    // a medium rule does not get that protection
    expect(capFindings([f("m", { ruleId: "tests", severity: "low", confidence: 0.3 }), f("g", { severity: "high" })], rules, 1).kept.map((x) => x.title)).toEqual(["g"]);
  });
});
