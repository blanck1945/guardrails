import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Rule } from "../config";
import { reviewDiff } from "../review";
import { buildSystemPrompt } from "../prompt";
import { defaultCoverage, parseCheck } from "./spec";
import { runChecks } from "./run";
import { parseUnifiedDiff } from "../diff";
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
  file: "src/List.tsx",
  line: 8,
  type: "style",
  severity: "medium",
  confidence: 0.9,
  title: "Unaccented Spanish heading",
  body: "The heading is Spanish.",
  ruleId: "ui-spanish",
  evidence: [{ file: "src/List.tsx", startLine: 8, endLine: 8, note: "x" }],
  ...over,
});

// Line 2 has an accent (the check sees it); line 8 is Spanish without accents (the check cannot see it).
const listFile = ["export function List() {", "  // recordatorio pendiente: ñandú", "  return (", "    <div>", "      <ul />", "    </div>", "  );", "  <h2>Recordatorios</h2>", "}", ""].join("\n");
const files = { "src/List.tsx": listFile, "src/big.ts": "1\n2\n3\n4\n" };
const input = { diff: addDiff(files), context: {}, docs: {} };
const ws = memWorkspace(files);

const partialRule: Rule = { id: "ui-spanish", rule: "UI text is Spanish; code is English.", scope: ["src/**"], severity: "medium", status: "active", check: "forbid-pattern: [áéíóúñ]" };
const exhaustiveRule: Rule = { id: "short", rule: "Files under 3 lines.", scope: ["src/big.ts"], severity: "high", status: "active", check: "max-lines: 3" };
const config = { ...defaultConfig, rules: [partialRule, exhaustiveRule] };
const modelWith = (findings: object[]) => new MockLanguageModelV4({ doGenerate: async () => report({ findings }) });
const promptOf = (m: MockLanguageModelV4) => JSON.stringify(m.doGenerateCalls[0]!.prompt);

describe("check coverage", () => {
  it("defaults by kind", () => {
    const cov = (v: string) => {
      const p = parseCheck(v);
      if (!p.ok) throw new Error(p.error);
      return defaultCoverage(p.spec);
    };
    expect(cov("max-lines: 5")).toBe("exhaustive");
    expect(cov("colocated-test")).toBe("exhaustive");
    expect(cov("forbid-import: x")).toBe("partial");
    expect(cov("forbid-pattern: x")).toBe("partial");
  });

  it("runChecks splits ran into exhaustive and partial, with the reported locations", async () => {
    const out = await runChecks({ rules: config.rules, files: parseUnifiedDiff(input.diff), workspace: ws });
    expect([...out.ran].sort()).toEqual(["short", "ui-spanish"]);
    expect(out.exhaustive).toEqual(["short"]);
    expect(out.partial).toEqual([{ ruleId: "ui-spanish", locations: [{ file: "src/List.tsx", line: 2 }] }]);
  });

  it("the check-coverage override flips the default in both directions", async () => {
    const rules: Rule[] = [
      { ...partialRule, checkCoverage: "exhaustive" },
      { ...exhaustiveRule, checkCoverage: "partial" },
    ];
    const out = await runChecks({ rules, files: parseUnifiedDiff(input.diff), workspace: ws });
    expect(out.exhaustive).toEqual(["ui-spanish"]);
    expect(out.partial.map((p) => p.ruleId)).toEqual(["short"]);
  });
});

describe("reviewDiff with partial and exhaustive checks", () => {
  it("skips an exhaustive rule and lists a partial rule to the model with the reported locations", async () => {
    const model = modelWith([]);
    await reviewDiff(input, { config, model, mode: "agent", workspace: ws });
    const prompt = promptOf(model);
    expect(prompt).toContain("already verified mechanically");
    expect(prompt).not.toContain("[short] (");
    expect(prompt).toContain("[ui-spanish] (");
    expect(prompt).toContain("partial mechanical check");
    expect(prompt).toContain("already reported at src/List.tsx:2");
    expect(prompt).toContain("look for violations of the rule that the check cannot see");
  });

  it("the single-call prompt does the same", () => {
    const text = buildSystemPrompt(config, new Set(["short"]), [{ ruleId: "ui-spanish", locations: [{ file: "src/List.tsx", line: 2 }] }]);
    expect(text).toContain("[ui-spanish] (");
    expect(text).not.toContain("[short] (");
    expect(text).toContain("src/List.tsx:2");
  });

  it("folds a model finding on a location the check cannot see into the check comment (v0.8.1)", async () => {
    const r = await reviewDiff(input, { config, model: modelWith([llmFinding()]), mode: "agent", workspace: ws });
    const got = r.findings.map((f) => [f.origin, f.file, f.line, f.ruleId]);
    expect(got).toContainEqual(["check", "src/List.tsx", 2, "ui-spanish"]);
    expect(got).not.toContainEqual(["llm", "src/List.tsx", 8, "ui-spanish"]);
    expect(r.findings.find((f) => f.ruleId === "ui-spanish")!.body).toContain("Also at line 8.");
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });

  it("still drops a model finding that repeats a check finding (same file, rule and nearby line)", async () => {
    const dup = llmFinding({ line: 3, title: "Accent in comment", evidence: [{ file: "src/List.tsx", startLine: 3, endLine: 3, note: "x" }] });
    const r = await reviewDiff(input, { config, model: modelWith([dup]), mode: "agent", workspace: ws });
    expect(r.findings.map((f) => f.origin)).not.toContain("llm");
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });

  it("an exhaustive rule keeps dropping any model finding on the same file", async () => {
    const dup = llmFinding({ file: "src/big.ts", line: 1, ruleId: "short", evidence: [{ file: "src/big.ts", startLine: 1, endLine: 1, note: "x" }] });
    const r = await reviewDiff(input, { config, model: modelWith([dup]), mode: "agent", workspace: ws });
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });
});
