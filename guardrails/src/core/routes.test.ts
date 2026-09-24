import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "./config";
import { synthesizeRules } from "./init/synthesize";
import * as models from "./models";
import { reviewDiff } from "./review";
import type { Workspace } from "./workspace";

vi.mock("./models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models")>();
  return { ...actual, resolveModel: vi.fn(actual.resolveModel) };
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = { unified: "stop" as const, raw: undefined };
const input = { diff: "diff --git a/a.ts b/a.ts\n+x", context: {}, docs: {} };
const ws = { diff: async () => "diff" } as unknown as Workspace;

describe("every model call site goes through resolveModel", () => {
  const spy = vi.mocked(models.resolveModel);

  it("reviewDiff (single)", async () => {
    spy.mockClear();
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ summary: "ok", findings: [] }) }],
        finishReason: finish,
        usage,
        warnings: [],
      }),
    });
    await reviewDiff(input, { config: defaultConfig, model });
    expect(spy).toHaveBeenCalledWith(model);
  });

  it("reviewDiff (agent) -> runReviewAgent", async () => {
    spy.mockClear();
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "1",
            toolName: "report_findings",
            input: JSON.stringify({ findings: [] }),
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      }),
    });
    await reviewDiff(input, { config: defaultConfig, model, mode: "agent", workspace: ws });
    expect(spy).toHaveBeenCalledWith(model);
  });

  it("synthesizeRules", async () => {
    spy.mockClear();
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ rules: [] }) }],
        finishReason: finish,
        usage,
        warnings: [],
      }),
    });
    const ctx = { files: [{ path: "CLAUDE.md", kind: "doc", content: "x", truncated: false }], structure: "", skipped: [], totalChars: 1 };
    await synthesizeRules(ctx as never, { model });
    expect(spy).toHaveBeenCalledWith(model);
  });

  it("a spec string from GUARDRAILS_MODEL reaches the resolver (missing key -> clear error)", async () => {
    vi.stubEnv("GUARDRAILS_MODEL", "zai:glm-4.5-air");
    vi.stubEnv("ZAI_API_KEY", "");
    await expect(reviewDiff(input, { config: defaultConfig })).rejects.toThrow(/ZAI_API_KEY/);
    vi.unstubAllEnvs();
  });
});
