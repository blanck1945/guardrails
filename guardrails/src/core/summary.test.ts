import { describe, expect, it } from "vitest";
import { buildSummary, noteLines, statsFooter } from "./summary";

const selection = { mode: "deep", detail: "label guardrails:deep" } as const;

describe("buildSummary", () => {
  it("header, counts by origin, merged duplicates and at most two note lines", () => {
    const s = buildSummary({ selection, total: 3, fromChecks: 1, fromModel: 2, merged: 2, notes: "one; two; three" });
    expect(s).toBe("**Guardrails** · mode deep (label guardrails:deep)\n\n3 findings: 1 from checks, 2 from the model, 2 merged duplicates\n\none\ntwo");
  });
  it("no merged part when nothing merged; singular", () => {
    const s = buildSummary({ selection, total: 1, fromChecks: 0, fromModel: 1, merged: 0 });
    expect(s).toContain("1 finding: 0 from checks, 1 from the model");
    expect(s).not.toContain("merged");
  });
  it("no findings, incomplete and failure texts", () => {
    expect(buildSummary({ selection, total: 0, fromChecks: 0, fromModel: 0 })).toContain("No issues found.");
    expect(buildSummary({ selection, total: 0, fromChecks: 0, fromModel: 0, incomplete: true })).toContain("could not be completed");
    const s = buildSummary({ selection, total: 1, fromChecks: 1, fromModel: 0, modelIncomplete: "timeout", passes: 2, passesFailed: 2, omitted: 1 });
    expect(s).toContain("it ran out of time");
    expect(s).toContain("2 of 2 review passes did not complete");
    expect(s).toContain("1 lower-priority finding(s) omitted");
  });
  it("trims and caps note lines", () => {
    expect(noteLines("- a\n\n* b\nc")).toEqual(["a", "b"]);
    expect(noteLines("x".repeat(500))[0]!.length).toBeLessThanOrEqual(200);
    expect(noteLines(undefined)).toEqual([]);
  });
});

describe("statsFooter", () => {
  it("formats cost, seconds and passes", () => {
    expect(statsFooter({ costUsd: 0.0184, ms: 38_200, passes: 2 })).toBe("Cost ~US$0.02 · 38 s · 2 passes");
    expect(statsFooter({ costUsd: null, ms: 1000, passes: 1 })).toBe("Cost n/a · 1 s · 1 pass");
  });
});
