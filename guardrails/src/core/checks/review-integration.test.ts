import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { BudgetExceededError, CostTracker } from "../cost";
import { defaultConfig, type Rule } from "../config";
import { reviewDiff } from "../review";
import { addDiff, memWorkspace } from "./checks.test";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const report = (input: unknown): GenResult => ({
  content: [{ type: "tool-call", toolCallId: "r", toolName: "report_findings", input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
const llmFinding = (over: object = {}) => ({
  file: "src/big.ts",
  line: 2,
  type: "logic",
  severity: "high",
  confidence: 0.9,
  title: "Real bug",
  body: "Off by one.",
  evidence: [{ file: "src/big.ts", startLine: 1, endLine: 3, note: "x" }],
  ...over,
});

const rules: Rule[] = [
  { id: "short", rule: "Files under 3 lines.", scope: ["src/**"], severity: "high", status: "active", check: "max-lines: 3" },
  { id: "other", rule: "Other rule.", scope: ["src/**"], severity: "low", status: "active" },
];
const files = { "src/big.ts": "1\n2\n3\n4\n5\n" };
const input = { diff: addDiff(files), context: {}, docs: {} };
const config = { ...defaultConfig, rules };
const ws = memWorkspace(files);
const failing = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("provider down");
    },
  });

describe("reviewDiff with mechanical checks", () => {
  it("publishes check findings next to model findings, bypassing filters and cap", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => report({ findings: [llmFinding()] }) });
    const r = await reviewDiff(input, { config: { ...config, strictness: 1 }, model, mode: "agent", workspace: ws });
    expect(r.findings.map((f) => f.origin)).toEqual(["check", "llm"]);
    expect(r.findings[0]).toMatchObject({ ruleId: "short", confidence: 1, file: "src/big.ts", line: 4 });
    expect(r.checks).toMatchObject({ ran: ["short"], findings: 1 });
    expect(r.summary).toContain("1 finding(s) come from mechanical rule checks");
    expect(r.modelIncomplete).toBeUndefined();
  });

  it("tells the model which rules were verified mechanically", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => report({ findings: [] }) });
    await reviewDiff(input, { config, model, mode: "agent", workspace: ws });
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("already verified mechanically");
    expect(prompt).not.toContain("[short]");
    expect(prompt).toContain("[other]");
  });

  it("drops a model finding that duplicates a check (same file and rule)", async () => {
    const dup = llmFinding({ ruleId: "short", line: 1, title: "Too long" });
    const model = new MockLanguageModelV4({ doGenerate: async () => report({ findings: [dup] }) });
    const r = await reviewDiff(input, { config, model, mode: "agent", workspace: ws });
    expect(r.findings.map((f) => f.origin)).toEqual(["check"]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });

  it("still publishes the checks when the model fails", async () => {
    const r = await reviewDiff(input, { config, model: failing(), mode: "agent", workspace: ws });
    expect(r.findings.map((f) => f.origin)).toEqual(["check"]);
    expect(r.modelIncomplete).toBe("error");
    expect(r.summary).toContain("did not complete");
  });

  it("classifies a spent budget and a timeout", async () => {
    const snapshot = new CostTracker({ maxUsd: 1 }).snapshot();
    const spent = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new BudgetExceededError("Budget exceeded", snapshot);
      },
    });
    const b = await reviewDiff(input, { config, model: spent, mode: "agent", workspace: ws });
    expect(b.modelIncomplete).toBe("budget");
    expect(b.findings).toHaveLength(1);

    const ctl = new AbortController();
    ctl.abort();
    const t = await reviewDiff(input, { config, model: failing(), mode: "agent", workspace: ws, abortSignal: ctl.signal });
    expect(t.modelIncomplete).toBe("timeout");
  });

  it("without check findings a model failure still throws", async () => {
    const clean = { diff: addDiff({ "src/ok.ts": "1\n" }), context: {}, docs: {} };
    await expect(reviewDiff(clean, { config, model: failing(), mode: "agent", workspace: memWorkspace({ "src/ok.ts": "1\n" }) })).rejects.toThrow();
  });

  it("single mode without a workspace skips file-size checks and leaves the rule to the model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify({ summary: "ok", findings: [] }) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
    });
    const r = await reviewDiff(input, { config, model });
    expect(r.checks.skipped).toEqual([{ ruleId: "short", reason: "needs-workspace" }]);
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain("[short]");
  });
});
