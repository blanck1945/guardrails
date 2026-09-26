import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config";
import type { Workspace } from "../workspace";
import { WorkspaceError } from "../workspace";
import { runReviewAgent, type AgentRunResult } from "./loop";
import { mergeRuns } from "./passes";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const call = (toolName: string, input: unknown, id: string): GenResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});

const ws: Workspace = {
  readFile: async (i) => {
    if (i.path === "missing.ts") throw new WorkspaceError("file not found");
    return { path: i.path, ref: i.ref ?? "head", startLine: 1, endLine: 1, totalLines: 1, content: "1\tx", truncated: false };
  },
  grep: async () => ({ matches: [], truncated: false }),
  listFiles: async () => ({ files: [], truncated: false }),
  diff: async () => "",
  findReferencesByName: async () => ({ references: [], truncated: false }),
};

const input = { diff: "diff --git a/src/a.ts b/src/a.ts\n+x", context: {}, docs: {} };

describe("filesOpened", () => {
  it("collects head read_file paths across steps, ignores base and failed reads, dedupes and sorts", async () => {
    const script: GenResult[] = [
      call("read_file", { path: "src/b.ts" }, "1"),
      call("read_file", { path: "src/a.ts", ref: "head", startLine: 1, endLine: 5 }, "2"),
      call("read_file", { path: "src/a.ts", ref: "base" }, "3"),
      call("read_file", { path: "src/only-base.ts", ref: "base" }, "4"),
      call("read_file", { path: "src/a.ts", startLine: 6 }, "5"),
      call("read_file", { path: "missing.ts" }, "6"),
      call("grep", { pattern: "foo" }, "7"),
      call("report_findings", { findings: [] }, "8"),
    ];
    let n = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => script[n++]! });
    const r = await runReviewAgent({ model, config: defaultConfig, workspace: ws, input });
    expect(r.incomplete).toBe(false);
    expect(r.filesOpened).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("is empty when the agent opened nothing", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => call("report_findings", { findings: [] }, "1") });
    const r = await runReviewAgent({ model, config: defaultConfig, workspace: ws, input });
    expect(r.filesOpened).toEqual([]);
  });

  it("mergeRuns unions the paths of the passes", () => {
    const run = (filesOpened: string[], forcedWrapUp = false): AgentRunResult => ({
      findings: [],
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, steps: 0 },
      incomplete: false,
      invalidReports: 0,
      forcedWrapUp,
      filesOpened,
    });
    const merged = mergeRuns([run(["src/b.ts", "src/a.ts"]), run(["src/c.ts", "src/a.ts"], true)]);
    expect(merged.filesOpened).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(merged.forcedWrapUp).toBe(true);
  });
});
