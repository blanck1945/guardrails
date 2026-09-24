import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Rule } from "../config";
import { reportFindingsSchema } from "../findings";
import type { Workspace } from "../workspace";
import { runReviewAgent } from "./loop";
import { buildAgentInstructions, ruleChecksInstructions } from "./prompts";
import { GENERAL_BUDGET } from "./budget";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const report = (input: unknown, id = "r"): GenResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName: "report_findings", input: JSON.stringify(input) }],
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
const rules: Rule[] = [
  { id: "english", rule: "English only.", scope: ["src/**"], severity: "medium", status: "active" },
  { id: "tests", rule: "Colocated tests.", scope: ["src/**"], severity: "medium", status: "active", check: "colocated-test" },
  { id: "layers", rule: "Layering.", scope: ["src/**"], severity: "medium", status: "active" },
];
const config = { ...defaultConfig, rules };
const input = { diff: "d", context: {}, docs: {} };
const v = (ruleId: string, verdict = "ok") => ({ ruleId, verdict, file: "src/a.ts" });

function scripted(steps: GenResult[]) {
  let n = 0;
  return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(n++, steps.length - 1)]! });
}

describe("report_findings ruleChecks", () => {
  it("schema accepts verdicts and rejects unknown ones", () => {
    expect(reportFindingsSchema.safeParse({ findings: [], ruleChecks: [{ ruleId: "a", verdict: "violated", note: "x" }] }).success).toBe(true);
    expect(reportFindingsSchema.safeParse({ findings: [], ruleChecks: [{ ruleId: "a", verdict: "maybe" }] }).success).toBe(false);
    expect(reportFindingsSchema.safeParse({ findings: [] }).success).toBe(true);
  });
});

describe("agent prompt", () => {
  it("asks for a verdict per rule and all locations, but not for mechanical rules", () => {
    const p = buildAgentInstructions(config, GENERAL_BUDGET, new Set(["tests"]), { ruleChecks: "require" });
    expect(p).toContain("Exhaustive rule pass");
    expect(p).toContain("EVERY location");
    expect(p).toContain("rejected once");
    expect(p).toContain("[english]");
    expect(p).not.toContain("[tests]");
  });
  it("is absent when off or when there are no rules", () => {
    expect(ruleChecksInstructions("off", true)).toBe("");
    expect(ruleChecksInstructions("ask", false)).toBe("");
    expect(buildAgentInstructions(config, GENERAL_BUDGET, new Set(), { ruleChecks: "off" })).not.toContain("Exhaustive rule pass");
  });
  it("second-pass focus is added on request", () => {
    expect(buildAgentInstructions(config, GENERAL_BUDGET, new Set(), { focus: "rules-and-logic" })).toContain("Second-pass focus");
  });
});

describe("require mode", () => {
  const opts = (model: MockLanguageModelV4, extra: object = {}) => ({ model, config, workspace: ws, input, mechanicalRuleIds: new Set(["tests"]), ruleChecks: "require" as const, ...extra });

  it("accepts a complete report at once", async () => {
    const model = scripted([report({ findings: [], ruleChecks: [v("english"), v("layers")] })]);
    const r = await runReviewAgent(opts(model));
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(r.notes).toBeUndefined();
    expect(r.ruleChecks).toHaveLength(2);
  });

  it("bounces an incomplete report once and accepts the completed one", async () => {
    const model = scripted([report({ findings: [], ruleChecks: [v("english")] }, "a"), report({ findings: [], ruleChecks: [v("english"), v("layers", "violated")] }, "b")]);
    const r = await runReviewAgent(opts(model));
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(r.notes).toBeUndefined();
    expect(r.incomplete).toBe(false);
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("no verdict for rule(s) layers");
  });

  it("after one bounce accepts what there is and marks incomplete-rule-checks", async () => {
    const model = scripted([report({ findings: [], ruleChecks: [] }, "a"), report({ findings: [], notes: "n", ruleChecks: [v("english")] }, "b")]);
    const r = await runReviewAgent(opts(model));
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(r.notes).toBe("n; incomplete-rule-checks");
    expect(r.incomplete).toBe(false);
  });

  it("keeps the bounced report when the run ends before a second one", async () => {
    const finding = { file: "src/a.ts", line: 1, type: "style", severity: "low", confidence: 0.9, title: "T", body: "B", evidence: [{ file: "src/a.ts", startLine: 1, endLine: 1, note: "n" }] };
    const model = scripted([report({ findings: [finding], ruleChecks: [] })]);
    const r = await runReviewAgent(opts(model, { budget: { maxSteps: 1 } }));
    expect(r.findings).toHaveLength(1);
    expect(r.notes).toBe("incomplete-rule-checks");
  });

  it("ask mode never bounces", async () => {
    const model = scripted([report({ findings: [] })]);
    const r = await runReviewAgent(opts(model, { ruleChecks: "ask" }));
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(r.notes).toBeUndefined();
  });
});
