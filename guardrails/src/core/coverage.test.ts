import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Rule } from "./config";
import { computeCoverage, COVERAGE_REASONS, type CoverageFileInput, type CoverageInput } from "./coverage";
import { MODE_PRESETS } from "./modes";
import { reviewDiff } from "./review";
import type { Workspace } from "./workspace";

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({ id, rule: `Rule ${id}.`, scope: ["**"], severity: "medium", status: "active", ...over });
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

describe("computeCoverage: files", () => {
  it("gives each file one status, in the six kinds, with the ignore reason", () => {
    const c = computeCoverage(
      base({
        files: [file("z.ts"), file("gone.ts", "removed"), file("lock.json", "ignored", "default-ignore"), file("img.png", "no-diff"), file("big.ts", "over-budget"), file("a.ts")],
      }),
    );
    expect(c.files.byStatus).toEqual({ removed: 1, ignored: 1, "no-diff": 1, "over-budget": 1, "checks-only": 0, reviewed: 2 });
    expect(c.files.list.find((f) => f.path === "lock.json")).toMatchObject({ status: "ignored", ignoredBy: "default-ignore" });
    // not reviewed first, then reviewed; each sorted by path
    expect(c.files.list.map((f) => f.path)).toEqual(["big.ts", "gone.ts", "img.png", "lock.json", "a.ts", "z.ts"]);
  });

  it("in-input files are checks-only when the model part did not complete", () => {
    expect(computeCoverage(base({ modelIncomplete: "timeout", incomplete: true })).files.byStatus["checks-only"]).toBe(1);
    expect(computeCoverage(base({ incomplete: true })).files.byStatus["checks-only"]).toBe(1);
    expect(computeCoverage(base()).files.byStatus.reviewed).toBe(1);
  });

  it("flags opened files and counts context files opened outside the change", () => {
    const c = computeCoverage(base({ files: [file("src/a.ts"), file("src/b.ts")], filesOpened: ["src/a.ts", "src/util.ts", "src/other.ts"] }));
    expect(c.files.list.map((f) => [f.path, f.opened])).toEqual([["src/a.ts", true], ["src/b.ts", false]]);
    expect(c.files.contextFilesOpened).toBe(2);
  });
});

describe("computeCoverage: rules", () => {
  const files = [file("src/a.ts"), file("gone.ts", "removed"), file("x.lock", "ignored", "default-ignore")];

  it("counts rules in scope (active, matching a reviewable file) and out of scope", () => {
    const c = computeCoverage(
      base({
        files,
        rules: [rule("b-in"), rule("a-in"), rule("off", { status: "disabled" }), rule("sugg", { status: "suggested" }), rule("only-lock", { scope: ["**/*.lock"] }), rule("only-removed", { scope: ["gone.ts"] })],
        rulesOutOfScopeExtra: 2,
      }),
    );
    expect(c.rules.list.map((r) => r.id)).toEqual(["a-in", "b-in"]);
    expect(c.rules.inScope).toBe(2);
    expect(c.rules.outOfScope).toBe(4);
  });

  it("how: check, check+model, check-failed+model, model", () => {
    const c = computeCoverage(
      base({
        rules: [rule("ex"), rule("pa"), rule("fa"), rule("mo")],
        checks: { ran: ["ex", "pa"], exhaustive: ["ex"], partial: ["pa"], skipped: [{ ruleId: "fa", reason: "needs-workspace" }] },
        ruleChecks: [{ ruleId: "pa", verdict: "ok" }, { ruleId: "fa", verdict: "ok" }, { ruleId: "mo", verdict: "not-applicable" }],
        findings: [{ ruleId: "ex", origin: "check" }, { ruleId: "ex", origin: "check" }],
      }),
    );
    const by = Object.fromEntries(c.rules.list.map((r) => [r.id, r]));
    expect(by.ex).toMatchObject({ how: "check", check: { kind: "violations", count: 2 }, covered: true });
    expect(by.ex!.model).toBeUndefined();
    expect(by.pa).toMatchObject({ how: "check+model", check: { kind: "none-found", patternOnly: true }, model: { kind: "ok" } });
    expect(by.fa).toMatchObject({ how: "check-failed+model", check: { kind: "not-run" }, model: { kind: "ok" } });
    expect(by.mo).toMatchObject({ how: "model", model: { kind: "not-applicable" } });
    expect(c.rules).toMatchObject({ inScope: 4, byCheck: 1, byModel: 3, withVerdict: 3 });
  });

  it("an exhaustive check with no findings reads none found", () => {
    const c = computeCoverage(base({ rules: [rule("ex")], checks: { ran: ["ex"], exhaustive: ["ex"], partial: [], skipped: [] } }));
    expect(c.rules.list[0]!.check).toEqual({ kind: "none-found", patternOnly: false });
  });

  it("model result: first match wins (reported > violated > ok > not-applicable > no verdict)", () => {
    const r = (over: Partial<CoverageInput>) => computeCoverage(base({ rules: [rule("r")], ...over })).rules.list[0]!.model;
    expect(r({ findings: [{ ruleId: "r", origin: "llm" }, { ruleId: "r", origin: "llm" }], ruleChecks: [{ ruleId: "r", verdict: "ok" }] })).toEqual({ kind: "reported", count: 2 });
    expect(r({ ruleChecks: [{ ruleId: "r", verdict: "ok", file: "a" }, { ruleId: "r", verdict: "violated", file: "b" }] })).toEqual({ kind: "violated-not-published" });
    expect(r({ ruleChecks: [{ ruleId: "r", verdict: "not-applicable", file: "a" }, { ruleId: "r", verdict: "ok", file: "b" }] })).toEqual({ kind: "ok" });
    expect(r({ ruleChecks: [{ ruleId: "r", verdict: "not-applicable" }] })).toEqual({ kind: "not-applicable" });
    expect(r({})).toEqual({ kind: "no-verdict" });
  });

  it("violated but not published: with a dropped finding it says why, without it does not", () => {
    const verdicts = [{ ruleId: "r", verdict: "violated" as const }];
    const withDrop = computeCoverage(base({ rules: [rule("r")], ruleChecks: verdicts, dropped: [{ finding: { ruleId: "r" }, reason: "duplicate" }] }));
    expect(withDrop.rules.list[0]!.model).toEqual({ kind: "violated-not-published", filtered: "duplicate" });
    expect(withDrop.dropped).toEqual({ duplicate: 1 });
    expect(computeCoverage(base({ rules: [rule("r")], ruleChecks: verdicts })).rules.list[0]!.model).toEqual({ kind: "violated-not-published" });
  });

  it("a verdict without file covers the rule for every changed file", () => {
    const c = computeCoverage(base({ files: [file("a.ts"), file("b.ts")], rules: [rule("r")], ruleChecks: [{ ruleId: "r", verdict: "ok" }] }));
    expect(c.rules.list[0]).toMatchObject({ model: { kind: "ok" }, covered: true });
  });

  it("basic (ruleChecks off) and single mode say not asked; no verdict is not covered", () => {
    expect(computeCoverage(base({ rules: [rule("r")], ruleChecksMode: "off" })).rules.list[0]).toMatchObject({ model: { kind: "not-asked" }, covered: false });
    expect(computeCoverage(base({ rules: [rule("r")], engine: "single" })).rules.list[0]).toMatchObject({ model: { kind: "not-asked" }, covered: false });
    const c = computeCoverage(base({ rules: [rule("r")] }));
    expect(c.rules.list[0]).toMatchObject({ model: { kind: "no-verdict" }, covered: false });
    expect(c.rules.withVerdict).toBe(0);
  });

  it("model incomplete: not run and not covered by the model; a check part still reports", () => {
    const c = computeCoverage(
      base({
        rules: [rule("m"), rule("p")],
        modelIncomplete: "budget",
        incomplete: true,
        checks: { ran: ["p"], exhaustive: [], partial: ["p"], skipped: [] },
        findings: [{ ruleId: "p", origin: "check" }],
      }),
    );
    expect(c.rules.list.map((r) => [r.id, r.model, r.covered])).toEqual([["m", { kind: "not-run" }, false], ["p", { kind: "not-run" }, false]]);
    expect(c.rules.list[1]!.check).toEqual({ kind: "violations", count: 1 });
  });

  it("counts verdict conflicts (ok verdict but a published finding cites the rule)", () => {
    const c = computeCoverage(base({ rules: [rule("r"), rule("s")], ruleChecks: [{ ruleId: "r", verdict: "ok" }, { ruleId: "s", verdict: "violated" }], findings: [{ ruleId: "r", origin: "llm" }, { ruleId: "s", origin: "llm" }] }));
    expect(c.rules.verdictConflicts).toBe(1);
  });
});

describe("computeCoverage: reasons", () => {
  const reasons = (over: Partial<CoverageInput>) => computeCoverage(base(over)).reasons;

  it("is complete when nothing applies", () => {
    const c = computeCoverage(base());
    expect(c).toMatchObject({ complete: true, reasons: [] });
  });

  it("each code", () => {
    expect(reasons({ modelIncomplete: "timeout", incomplete: true })).toEqual(["model-timeout"]);
    expect(reasons({ modelIncomplete: "budget", incomplete: true })).toEqual(["model-budget"]);
    expect(reasons({ modelIncomplete: "error", incomplete: true })).toEqual(["model-error"]);
    expect(reasons({ incomplete: true })).toEqual(["no-valid-report"]);
    expect(reasons({ passes: 2, passesFailed: 1 })).toEqual(["pass-failed"]);
    expect(reasons({ forcedWrapUp: true })).toEqual(["step-budget"]);
    expect(reasons({ rules: [rule("r")] })).toEqual(["missing-verdicts"]);
    expect(reasons({ notes: "x; incomplete-rule-checks" })).toEqual(["missing-verdicts"]);
    expect(reasons({ files: [file("a.ts"), file("b.ts", "over-budget")] })).toEqual(["diff-over-budget"]);
    expect(reasons({ fallback: "download-failed" })).toEqual(["single-fallback"]);
    expect(reasons({ checks: { ran: [], exhaustive: [], partial: [], skipped: [{ ruleId: "c", reason: "invalid-check" }] } })).toEqual(["checks-skipped"]);
  });

  it("rules with no verdict are not a reason in single mode or when verdicts are off", () => {
    expect(reasons({ rules: [rule("r")], engine: "single" })).toEqual([]);
    expect(reasons({ rules: [rule("r")], ruleChecksMode: "off" })).toEqual([]);
  });

  it("several reasons come in the fixed order, whatever the input order", () => {
    const r = reasons({ fallback: "repo-too-large", forcedWrapUp: true, passesFailed: 1, passes: 2, modelIncomplete: "error", incomplete: true, files: [file("b.ts", "over-budget")], checks: { ran: [], exhaustive: [], partial: [], skipped: [{ ruleId: "c", reason: "read-failed" }] } });
    expect(r).toEqual(["model-error", "pass-failed", "step-budget", "diff-over-budget", "single-fallback", "checks-skipped"]);
    expect(r).toEqual(COVERAGE_REASONS.filter((x) => r.includes(x)));
  });

  it("output is deterministic and free of code: only paths, ids, counters and words", () => {
    const input = base({ files: [file("b.ts"), file("a.ts")], rules: [rule("z"), rule("y")] });
    const one = JSON.stringify(computeCoverage(input));
    expect(JSON.stringify(computeCoverage({ ...input, files: [...input.files].reverse(), rules: [...input.rules].reverse() }))).toBe(one);
    expect(one).not.toContain("Rule y.");
  });
});

// Integration: coverage as `reviewDiff` returns it (mock models only).
type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const toolCall = (toolName: string, input: unknown, id = "r"): GenResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
const ws: Workspace = {
  readFile: async (i) => ({ path: i.path, ref: i.ref ?? "head", startLine: 1, endLine: 1, totalLines: 1, content: "1\tx", truncated: false }),
  grep: async () => ({ matches: [], truncated: false }),
  listFiles: async () => ({ files: [], truncated: false }),
  diff: async () => "",
  findReferencesByName: async () => ({ references: [], truncated: false }),
};
const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,2 @@", " x", "+// TODO later", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1,1 +1,2 @@", " y", "+const y = 2;", ""].join("\n");
const input = { diff, context: {}, docs: {} };
const rules: Rule[] = [rule("english", { check: "forbid-pattern: TODO", checkCoverage: "exhaustive" }), rule("layers")];
const config = { ...defaultConfig, rules };
const finding = { file: "src/b.ts", line: 2, type: "logic", severity: "high", confidence: 0.9, title: "Off by one", body: "Wrong.", ruleId: "layers", evidence: [{ file: "src/b.ts", startLine: 2, endLine: 2, note: "n" }] };

describe("reviewDiff coverage", () => {
  it("agent mode: ruleChecks, checks and files opened reach the coverage", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => (n++ === 0 ? toolCall("read_file", { path: "src/a.ts" }, "1") : toolCall("report_findings", { findings: [finding], ruleChecks: [{ ruleId: "layers", verdict: "violated" }] })),
    });
    const r = await reviewDiff(input, { config, model, mode: "agent", workspace: ws });
    expect(r.checks).toMatchObject({ ran: ["english"], exhaustive: ["english"], partial: [] });
    expect(r.filesOpened).toEqual(["src/a.ts"]);
    expect(r.forcedWrapUp).toBe(false);
    expect(r.coverage).toMatchObject({ complete: true, files: { total: 2, byStatus: { reviewed: 2 } }, rules: { inScope: 2, byCheck: 1, byModel: 1, withVerdict: 1 } });
    expect(r.coverage.rules.list).toEqual([
      { id: "english", how: "check", check: { kind: "violations", count: 1 }, covered: true },
      { id: "layers", how: "model", model: { kind: "reported", count: 1 }, covered: true },
    ]);
    expect(r.coverage.files.list.find((f) => f.path === "src/a.ts")!.opened).toBe(true);
  });

  it("forcedWrapUp propagates to the output and to the coverage reasons", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => (n++ < 3 ? toolCall("grep", { pattern: "x" }, `g${n}`) : toolCall("report_findings", { findings: [], ruleChecks: [{ ruleId: "layers", verdict: "ok" }] })),
    });
    const r = await reviewDiff(input, { config, model, mode: "agent", workspace: ws, reviewMode: { preset: MODE_PRESETS.basic } });
    expect(r.forcedWrapUp).toBe(true);
    expect(r.coverage.reasons).toContain("step-budget");
    expect(r.coverage.complete).toBe(false);
  });

  it("deep with two passes and one failed: verdicts merged, pass-failed reason, files still reviewed", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (o) => {
        if (JSON.stringify(o.prompt).includes("Second-pass focus")) throw new Error("boom");
        return toolCall("report_findings", { findings: [], ruleChecks: [{ ruleId: "layers", verdict: "ok" }] });
      },
    });
    const r = await reviewDiff(input, { config, model, mode: "agent", workspace: ws, reviewMode: { preset: MODE_PRESETS.deep } });
    expect(r.coverage.engine).toMatchObject({ mode: "agent", passes: 2, passesFailed: 1 });
    expect(r.coverage.reasons).toEqual(["pass-failed"]);
    expect(r.coverage.files.byStatus.reviewed).toBe(2);
    expect(r.coverage.rules.list.find((x) => x.id === "layers")!.model).toEqual({ kind: "ok" });
  });

  it("deep with two passes: the union of verdicts and opened files counts both passes", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (o) => {
        const second = JSON.stringify(o.prompt).includes("Second-pass focus");
        const steps = o.prompt.filter((m) => m.role === "tool").length;
        if (steps === 0) return toolCall("read_file", { path: second ? "src/util.ts" : "src/a.ts" }, "1");
        return toolCall("report_findings", { findings: [], ruleChecks: [{ ruleId: "layers", verdict: second ? "violated" : "ok" }] });
      },
    });
    const r = await reviewDiff(input, { config, model, mode: "agent", workspace: ws, reviewMode: { preset: MODE_PRESETS.deep } });
    expect(r.filesOpened).toEqual(["src/a.ts", "src/util.ts"]);
    expect(r.coverage.files.contextFilesOpened).toBe(1);
    // a violation seen by any pass stands, but nothing was published for it
    expect(r.coverage.rules.list.find((x) => x.id === "layers")!.model).toMatchObject({ kind: "violated-not-published" });
    expect(r.coverage.complete).toBe(true);
  });

  it("single mode: rules are not asked, the full-file contexts count as opened, no verdict reason", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ summary: "ok", findings: [] }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const r = await reviewDiff({ ...input, context: { "src/b.ts": "const y = 2;" } }, { config, model, mode: "single" });
    expect(r.filesOpened).toEqual(["src/b.ts"]);
    expect(r.coverage.engine.mode).toBe("single");
    expect(r.coverage.rules.list.find((x) => x.id === "layers")!.model).toEqual({ kind: "not-asked" });
    expect(r.coverage.reasons).toEqual([]);
  });

  it("the caller can pass every changed file and the fallback; both reach the coverage", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ summary: "ok", findings: [] }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const r = await reviewDiff(input, {
      config,
      model,
      mode: "single",
      coverage: { files: [file("src/a.ts"), file("src/b.ts"), file("old.ts", "removed"), file("pnpm-lock.yaml", "ignored", "default-ignore")], rulesOutOfScope: 3, fallback: "download-failed" },
    });
    expect(r.coverage.files.byStatus).toMatchObject({ removed: 1, ignored: 1, reviewed: 2 });
    expect(r.coverage.rules.outOfScope).toBe(3);
    expect(r.coverage.reasons).toEqual(["single-fallback"]);
  });

  it("a model failure with check findings: files are checks-only and the reason is the failure", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new DOMException("t", "TimeoutError"); } });
    const r = await reviewDiff(input, { config, model, mode: "agent", workspace: ws });
    expect(r.modelIncomplete).toBe("timeout");
    expect(r.coverage.reasons).toEqual(["model-timeout"]);
    expect(r.coverage.files.byStatus["checks-only"]).toBe(2);
    expect(r.coverage.rules.list.map((x) => x.model?.kind)).toEqual([undefined, "not-run"]);
  });
});
