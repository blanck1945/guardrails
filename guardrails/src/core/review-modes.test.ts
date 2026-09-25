import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { BOTH_PASSES_BOOST, mergeFindings } from "./agent/passes";
import { defaultConfig, type Rule } from "./config";
import { MODE_PRESETS, type ModeName } from "./modes";
import { reviewDiff } from "./review";
import type { Workspace } from "./workspace";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const report = (input: unknown): GenResult => ({
  content: [{ type: "tool-call", toolCallId: "r", toolName: "report_findings", input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
const ws: Workspace = {
  readFile: async () => { throw new Error("x"); },
  grep: async () => ({ matches: [], truncated: false }),
  listFiles: async () => ({ files: [], truncated: false }),
  diff: async () => "",
  findReferencesByName: async () => ({ references: [], truncated: false }),
};
const f = (over: object = {}) => ({
  file: "src/a.ts",
  line: 2,
  type: "logic",
  severity: "medium",
  confidence: 0.7,
  title: "Off by one",
  body: "Loop bound is wrong.",
  evidence: [{ file: "src/a.ts", startLine: 1, endLine: 3, note: "loop" }],
  ...over,
});
const input = { diff: "diff --git a/src/a.ts b/src/a.ts\n+x", context: {}, docs: {} };
const run = (model: MockLanguageModelV4, name: ModeName, extra: object = {}) =>
  reviewDiff(input, { config: defaultConfig, model, mode: "agent", workspace: ws, reviewMode: { preset: MODE_PRESETS[name], selection: { mode: name, source: "label", detail: `label guardrails:${name}` } }, ...extra });

describe("presets applied by reviewDiff", () => {
  const list = [f({ confidence: 0.9, title: "A", line: 1 }), f({ confidence: 0.7, title: "B", line: 10 }), f({ confidence: 0.5, title: "C", line: 20 }), f({ confidence: 0.45, title: "D", line: 30 }), f({ confidence: 0.42, title: "E", line: 40 })];
  const model = () => new MockLanguageModelV4({ doGenerate: async () => report({ findings: list }) });

  it("basic keeps confidence >= 0.8", async () => {
    const r = await run(model(), "basic");
    expect(r.findings.map((x) => x.title)).toEqual(["A"]);
  });
  it("standard keeps confidence >= 0.6 (strictness 2)", async () => {
    const r = await run(model(), "standard");
    expect(r.findings.map((x) => x.title)).toEqual(["A", "B"]);
  });
  it("deep keeps confidence >= 0.4 and a cap of 12", async () => {
    const many = Array.from({ length: 15 }, (_, i) => f({ confidence: 0.9 - i * 0.02, title: `Distinct problem number ${i}`, line: 10 + i * 5 }));
    const r = await run(new MockLanguageModelV4({ doGenerate: async () => report({ findings: many }) }), "deep");
    expect(r.findings).toHaveLength(12);
    expect(r.dropped.filter((d) => d.reason === "over-cap")).toHaveLength(3);
    const low = await run(model(), "deep");
    expect(low.findings.map((x) => x.title).sort()).toEqual(["A", "B", "C", "D", "E"]);
  });
  it("basic caps at 3 findings", async () => {
    const many = Array.from({ length: 6 }, (_, i) => f({ confidence: 0.95, title: `Distinct problem number ${i}`, line: 10 + i * 5 }));
    const r = await run(new MockLanguageModelV4({ doGenerate: async () => report({ findings: many }) }), "basic");
    expect(r.findings).toHaveLength(3);
  });
  it("the step budget and ruleChecks come from the preset", async () => {
    const rules: Rule[] = [{ id: "english", rule: "English.", scope: ["**"], severity: "low", status: "active" }];
    let calls = 0;
    const m = new MockLanguageModelV4({ doGenerate: async () => (calls++ < 3 ? { content: [{ type: "tool-call" as const, toolCallId: `g${calls}`, toolName: "grep", input: JSON.stringify({ pattern: "x" }) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] } : report({ findings: [] })) });
    await reviewDiff(input, { config: { ...defaultConfig, rules }, model: m, mode: "agent", workspace: ws, reviewMode: { preset: MODE_PRESETS.basic } });
    // basic: maxSteps 4 -> the 4th step is the forced report; no per-rule verdicts are asked
    expect(m.doGenerateCalls).toHaveLength(4);
    expect(JSON.stringify(m.doGenerateCalls[0]!.prompt)).not.toContain("Exhaustive rule pass");
    expect(m.doGenerateCalls[0]!.temperature).toBe(0);
  });
  it("the summary states the mode and why", async () => {
    const r = await run(model(), "deep");
    expect(r.summary).toContain("Review mode: deep (label guardrails:deep).");
    expect(r.modeSelection).toMatchObject({ mode: "deep", source: "label" });
  });
});

describe("deep: two passes", () => {
  const rules: Rule[] = [{ id: "english", rule: "English.", scope: ["**"], severity: "low", status: "active" }];
  const config = { ...defaultConfig, rules };

  it("runs two concurrent passes with different focus and merges them", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (o) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        const second = JSON.stringify(o.prompt).includes("Second-pass focus");
        return report({ findings: second ? [f({ title: "Off by one in loop", confidence: 0.7 }), f({ file: "src/b.ts", line: 5, title: "Only second", confidence: 0.7 })] : [f({ title: "Off by one loop bound", confidence: 0.7 }), f({ line: 50, title: "Only first", confidence: 0.7 })], ruleChecks: [{ ruleId: "english", verdict: "ok" }] });
      },
    });
    const r = await reviewDiff(input, { config, model, mode: "agent", workspace: ws, reviewMode: { preset: MODE_PRESETS.deep } });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(maxInFlight).toBe(2);
    const byTitle = Object.fromEntries(r.findings.map((x) => [x.title, x.confidence]));
    expect(r.findings).toHaveLength(3);
    // found in both passes: confidence boosted; found once: untouched
    const both = r.findings.find((x) => x.line === 2)!;
    expect(both.confidence).toBeCloseTo(0.7 + BOTH_PASSES_BOOST);
    expect(byTitle["Only first"]).toBe(0.7);
    expect(byTitle["Only second"]).toBe(0.7);
    expect(r.usage.steps).toBe(2);
    expect(r.passes).toBe(2);
    expect(r.passesFailed).toBe(0);
  });

  it("if one pass fails the other still publishes and the summary says so", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (o) => {
        if (JSON.stringify(o.prompt).includes("Second-pass focus")) throw new Error("boom");
        return report({ findings: [f({ confidence: 0.9 })], ruleChecks: [{ ruleId: "english", verdict: "ok" }] });
      },
    });
    const r = await reviewDiff(input, { config, model, mode: "agent", workspace: ws, reviewMode: { preset: MODE_PRESETS.deep } });
    expect(r.findings).toHaveLength(1);
    expect(r.passesFailed).toBe(1);
    expect(r.summary).toContain("1 of 2 review passes did not complete");
    expect(r.modelIncomplete).toBeUndefined();
  });

  it("if both passes time out only the mechanical checks are published", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new DOMException("t", "TimeoutError"); } });
    const checked = { ...config, rules: [{ ...rules[0]!, id: "short", check: "forbid-pattern: TODO" }] };
    const withTodo = { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n x\n+// TODO later\n", context: {}, docs: {} };
    const r = await reviewDiff(withTodo, { config: checked, model, mode: "agent", workspace: ws, abortSignal: ctl.signal, reviewMode: { preset: MODE_PRESETS.deep } });
    expect(r.modelIncomplete).toBe("timeout");
    expect(r.findings.map((x) => x.origin)).toEqual(["check"]);
  });

  it("mergeFindings boosts once, keeps the stronger version and unions evidence", () => {
    const a = { ...f({ severity: "low", confidence: 0.5 }), evidence: [{ file: "src/a.ts", startLine: 2, endLine: 2, note: "a" }] } as never;
    const b = { ...f({ severity: "high", confidence: 0.6, line: 3 }), evidence: [{ file: "src/a.ts", startLine: 3, endLine: 3, note: "b" }] } as never;
    const merged = mergeFindings([[a], [b]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ severity: "high", line: 3 });
    expect(merged[0]!.confidence).toBeCloseTo(0.7);
    expect(merged[0]!.evidence).toHaveLength(2);
  });
});

describe("deep: one problem, one comment, on the quoted line", () => {
  const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,9 @@", " head", "+// a", "+// b", "+// c", "+// d", "+// e", "+// f", "+export function addBusinessDays() {}", " tail", ""].join("\n");
  it("merges the two passes and anchors to the line that holds the quoted code", async () => {
    const mk = (line: number, title: string) => f({ line, title, ruleId: undefined, severity: "medium", confidence: 0.8, evidence: [{ file: "src/a.ts", startLine: 2, endLine: 8, note: "reimplements `export function addBusinessDays`" }] });
    const model = new MockLanguageModelV4({
      doGenerate: async (o) => {
        const second = JSON.stringify(o.prompt).includes("Second-pass focus");
        return report({ findings: [second ? mk(9, "Deadline helper duplicated in hook") : mk(2, "Business day helper duplicated in hook")], ruleChecks: [] });
      },
    });
    const r = await reviewDiff({ ...input, diff }, { config: defaultConfig, model, mode: "agent", workspace: ws, reviewMode: { preset: MODE_PRESETS.deep } });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.line).toBe(8);
    expect(r.merged).toBe(1);
  });
});
