import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config";
import { reviewDiff } from "../review";
import type { Workspace } from "../workspace";
import { elideOldToolResults } from "./budget";
import { runReviewAgent } from "./loop";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const validFinding = {
  file: "src/a.ts",
  line: 2,
  type: "logic",
  severity: "high",
  confidence: 0.9,
  title: "Off by one",
  body: "Loop bound is wrong.",
  evidence: [{ file: "src/a.ts", startLine: 1, endLine: 3, note: "loop" }],
};

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const call = (toolName: string, input: unknown, id: string, u = usage(100, 10)): GenResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: u,
  warnings: [],
});

const ws: Workspace = {
  readFile: async (i) => ({
    path: i.path,
    ref: i.ref ?? "head",
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    content: "1\tconst x = 1;",
    truncated: false,
  }),
  grep: async () => ({ matches: [], truncated: false }),
  listFiles: async () => ({ files: ["src/a.ts"], truncated: false }),
  diff: async () => "diff --git a/src/a.ts b/src/a.ts\n",
  findReferencesByName: async () => ({ references: [], truncated: false }),
};

const input = { diff: "diff --git a/src/a.ts b/src/a.ts\n+x", context: {}, docs: {} };

function scripted(steps: (o: CallOptions, n: number) => GenResult) {
  let n = 0;
  const model = new MockLanguageModelV4({ doGenerate: async (o) => steps(o, n++) });
  return model;
}

describe("runReviewAgent", () => {
  it("finishes on a valid report_findings and sums usage across steps", async () => {
    const model = scripted((_o, n) =>
      n === 0
        ? call("read_file", { path: "src/a.ts" }, "c1", usage(1000, 50))
        : call("report_findings", { findings: [validFinding] }, "c2", { ...usage(2000, 70), inputTokens: { total: 2000, noCache: 1500, cacheRead: 500, cacheWrite: 0 } }),
    );
    const r = await runReviewAgent({ model, config: defaultConfig, workspace: ws, input });
    expect(r.incomplete).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.forcedWrapUp).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(r.usage).toEqual({ inputTokens: 3000, cachedInputTokens: 500, outputTokens: 120, steps: 2 });
  });

  it("forces report_findings at step max-1 when the model keeps exploring", async () => {
    const model = scripted((o, n) => {
      const forced = o.toolChoice?.type === "tool";
      return forced
        ? call("report_findings", { findings: [] }, `r${n}`)
        : call("grep", { pattern: "foo" }, `g${n}`);
    });
    const r = await runReviewAgent({
      model,
      config: defaultConfig,
      workspace: ws,
      input,
      budget: { maxSteps: 4 },
    });
    expect(model.doGenerateCalls).toHaveLength(4);
    // Steps 0..2 are free, step 3 (= max-1) is forced.
    for (let i = 0; i < 3; i++) expect(model.doGenerateCalls[i]!.toolChoice).toEqual({ type: "required" });
    const last = model.doGenerateCalls[3]!;
    expect(last.toolChoice).toEqual({ type: "tool", toolName: "report_findings" });
    expect(last.tools?.map((t) => t.name)).toEqual(["report_findings"]);
    expect(r.forcedWrapUp).toBe(true);
    expect(r.incomplete).toBe(false);
  });

  it("forces the wrap-up early when input tokens reach 80% of the budget", async () => {
    const model = scripted((o, n) =>
      o.toolChoice?.type === "tool"
        ? call("report_findings", { findings: [] }, "r")
        : call("grep", { pattern: "x" }, `g${n}`, usage(900, 10)),
    );
    await runReviewAgent({
      model,
      config: defaultConfig,
      workspace: ws,
      input,
      budget: { maxInputTokens: 1000, maxSteps: 10 },
    });
    // step 0 uses 900 (>= 800) so step 1 is forced.
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(model.doGenerateCalls[1]!.toolChoice).toEqual({ type: "tool", toolName: "report_findings" });
  });

  it("retries after an invalid report and accepts the corrected one", async () => {
    const model = scripted((_o, n) =>
      n === 0
        ? call("report_findings", { findings: [{ file: "x" }] }, "bad")
        : call("report_findings", { findings: [validFinding] }, "good"),
    );
    const r = await runReviewAgent({ model, config: defaultConfig, workspace: ws, input });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(r.invalidReports).toBe(1);
    expect(r.incomplete).toBe(false);
    expect(r.findings).toHaveLength(1);
    // The second call must have seen the first call's error in its messages.
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("bad");
  });

  it("gives up after 2 retries and salvages the valid items of the last report", async () => {
    const model = scripted((_o, n) =>
      call("report_findings", { findings: [validFinding, { file: "broken" }] }, `bad${n}`),
    );
    const r = await runReviewAgent({ model, config: defaultConfig, workspace: ws, input });
    expect(model.doGenerateCalls).toHaveLength(3); // 1 attempt + 2 retries
    expect(r.incomplete).toBe(true);
    expect(r.invalidReports).toBe(3);
    expect(r.findings).toEqual([validFinding]);
  });
});

describe("elideOldToolResults", () => {
  const step = (i: number): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read_file", input: { path: `f${i}` } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read_file", output: { type: "text", value: "BIG" } }] },
  ];

  it("stubs results older than N steps and keeps recent ones", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hi" }, ...[0, 1, 2, 3, 4, 5].flatMap(step)];
    const out = elideOldToolResults(msgs, 4);
    const values = out
      .filter((m) => m.role === "tool")
      .map((m) => (m.content as { output: { value: string } }[])[0]!.output.value);
    expect(values.slice(0, 2).every((v) => v.startsWith("[elided: read_file"))).toBe(true);
    expect(values.slice(2)).toEqual(["BIG", "BIG", "BIG", "BIG"]);
  });
});

describe("reviewDiff modes", () => {
  it("agent mode requires a workspace", async () => {
    const model = new MockLanguageModelV4();
    await expect(reviewDiff(input, { config: defaultConfig, model, mode: "agent" })).rejects.toThrow(/workspace/);
  });

  it("agent mode filters by strictness and returns usage", async () => {
    const model = scripted(() =>
      call("report_findings", { findings: [validFinding, { ...validFinding, confidence: 0.1 }] }, "r"),
    );
    const r = await reviewDiff(input, { config: defaultConfig, model, mode: "agent", workspace: ws });
    expect(r.findings).toHaveLength(1);
    expect(r.usage.inputTokens).toBe(100);
    expect(r.mode).toBe("agent");
  });

  it("single mode uses generateText with structured output (no tools)", async () => {
    const payload = { summary: "ok", findings: [] };
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usage(50, 5),
        warnings: [],
      },
    });
    const r = await reviewDiff(input, { config: defaultConfig, model });
    expect(r.summary).toBe("ok");
    expect(r.mode).toBe("single");
    expect(r.usage).toMatchObject({ inputTokens: 50, outputTokens: 5 });
    expect(model.doGenerateCalls[0]!.responseFormat?.type).toBe("json");
  });
});

describe("reviewDiff absence-claim verification", () => {
  it("drops a finding that says a file is missing when the head tree has it", async () => {
    const claim = { ...validFinding, title: "Missing test", body: "no foo.test.ts exists next to it" };
    const wsFiles = { ...ws, listFiles: async () => ({ files: [validFinding.file.replace(/[^/]*$/, "") + "foo.test.ts"], truncated: false }) } as unknown as typeof ws;
    const model = scripted(() => call("report_findings", { findings: [claim] }, "r"));
    const r = await reviewDiff(input, { config: defaultConfig, model, mode: "agent", workspace: wsFiles });
    expect(r.findings).toHaveLength(0);
    expect(r.dropped.map((d) => d.reason)).toEqual(["contradicted-by-repo"]);
  });
});

describe("reviewDiff noise limits", () => {
  it("caps by strictness, records over-cap drops and mentions them in the summary", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...validFinding, line: 10 + i, title: `Problem ${i}`, confidence: 0.9 - i * 0.05 }));
    const model = scripted(() => call("report_findings", { findings: many }, "r"));
    const r = await reviewDiff(input, { config: { ...defaultConfig, strictness: 2 }, model, mode: "agent", workspace: ws });
    expect(r.findings).toHaveLength(5);
    expect(r.dropped.map((d) => d.reason)).toEqual(["over-cap"]);
    expect(r.summary).toContain("1 lower-priority finding(s) omitted");
  });

  it("keeps at most 2 findings on the same line", async () => {
    const same = [0, 1, 2].map((i) => ({ ...validFinding, title: `Different title ${i}`, confidence: 0.9 - i * 0.1 }));
    const model = scripted(() => call("report_findings", { findings: same }, "r"));
    const r = await reviewDiff(input, { config: defaultConfig, model, mode: "agent", workspace: ws });
    expect(r.findings).toHaveLength(2);
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });
});
