import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config";
import { llmCacheKey } from "./llm-cache";
import { reviewDiff } from "./review";
import { runReviewAgent } from "./agent/loop";
import { DEFAULT_SEED, providerSupportsSeed, samplingFor } from "./sampling";
import { synthesizeRules } from "./init/synthesize";
import type { Workspace } from "./workspace";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const text = (t: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(t) }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
const ws: Workspace = {
  readFile: async () => { throw new Error("x"); },
  grep: async () => ({ matches: [], truncated: false }),
  listFiles: async () => ({ files: [], truncated: false }),
  diff: async () => "",
  findReferencesByName: async () => ({ references: [], truncated: false }),
};

describe("samplingFor", () => {
  it("defaults to temperature 0 and no seed for Z.ai, DeepSeek and Anthropic", () => {
    for (const spec of ["zai:glm-5.3", "deepseek:deepseek-chat", "anthropic/claude-sonnet-5"]) {
      expect(samplingFor(spec, undefined, {})).toEqual({ temperature: 0 });
    }
  });
  it("sends a fixed seed only where the provider documents it", () => {
    expect(providerSupportsSeed("zai:glm-5.3")).toBe(false);
    expect(samplingFor("openai/gpt-5", undefined, {})).toEqual({ temperature: 0, seed: DEFAULT_SEED });
  });
  it("mode preference, env override and clamping", () => {
    expect(samplingFor("zai:glm-5.3", 0.3, {})).toEqual({ temperature: 0.3 });
    expect(samplingFor("zai:glm-5.3", 0.3, { GUARDRAILS_TEMPERATURE: "0.7" })).toEqual({ temperature: 0.7 });
    expect(samplingFor("zai:glm-5.3", 0.3, { GUARDRAILS_TEMPERATURE: "5" })).toEqual({ temperature: 1 });
    expect(samplingFor("zai:glm-5.3", 0.3, { GUARDRAILS_TEMPERATURE: "abc" })).toEqual({ temperature: 0.3 });
    expect(samplingFor("anthropic/claude-sonnet-5", undefined, { GUARDRAILS_TEMPERATURE: "1.5" })).toEqual({ temperature: 1.5 });
  });
  it("GUARDRAILS_SEED forces a seed on any provider", () => {
    expect(samplingFor("zai:glm-5.3", undefined, { GUARDRAILS_SEED: "7" })).toEqual({ temperature: 0, seed: 7 });
    expect(samplingFor("zai:glm-5.3", undefined, { GUARDRAILS_SEED: "1.5" })).toEqual({ temperature: 0 });
  });
});

describe("temperature reaches every call", () => {
  it("single review", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => text({ summary: "ok", findings: [] }) });
    await reviewDiff({ diff: "", context: {}, docs: {} }, { config: defaultConfig, model });
    expect(model.doGenerateCalls[0]!.temperature).toBe(0);
    expect(model.doGenerateCalls[0]!.seed).toBeUndefined();
  });
  it("agent review, with a mode temperature", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "tool-call" as const, toolCallId: "r", toolName: "report_findings", input: JSON.stringify({ findings: [] }) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] }),
    });
    await runReviewAgent({ model, config: defaultConfig, workspace: ws, input: { diff: "d", context: {}, docs: {} }, temperature: 0.2 });
    expect(model.doGenerateCalls[0]!.temperature).toBe(0.2);
  });
  it("init synthesis", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => text({ rules: [] }) });
    await synthesizeRules({ files: [{ path: "CLAUDE.md", kind: "docs", content: "x", truncated: false }], structure: "", skipped: [], totalChars: 1 } as never, { model });
    expect(model.doGenerateCalls[0]!.temperature).toBe(0);
  });
});

describe("LLM cache key", () => {
  it("changes with temperature and seed", () => {
    const base = { prompt: "p", temperature: 0 };
    const k = llmCacheKey("zai:glm-5.3", base);
    expect(llmCacheKey("zai:glm-5.3", { ...base, temperature: 0.5 })).not.toBe(k);
    expect(llmCacheKey("zai:glm-5.3", { ...base, seed: 1 })).not.toBe(k);
    expect(llmCacheKey("zai:glm-5.3", { ...base })).toBe(k);
  });
});
