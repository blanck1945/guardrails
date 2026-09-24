import { generateText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CostTracker } from "./cost";
import { LlmCache, llmCacheEnabledByEnv, llmCacheKey } from "./llm-cache";
import { resolveModel } from "./models";

const newCache = () => new LlmCache(mkdtempSync(path.join(os.tmpdir(), "gr-llm-cache-")));

function mock(id = "mock-model-id") {
  return new MockLanguageModelV4({
    modelId: id,
    doGenerate: async () => ({
      content: [{ type: "text", text: "hello" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

describe("LLM cache", () => {
  it("is off by default and on with GUARDRAILS_LLM_CACHE=1", () => {
    expect(llmCacheEnabledByEnv({})).toBe(false);
    expect(llmCacheEnabledByEnv({ GUARDRAILS_LLM_CACHE: "0" })).toBe(false);
    expect(llmCacheEnabledByEnv({ GUARDRAILS_LLM_CACHE: "1" })).toBe(true);
    const raw = mock();
    expect(resolveModel(raw, { env: {} })).toBe(raw); // no wrapping without cache/tracker
  });

  it("a second identical call never reaches the model and returns the same result and usage", async () => {
    const cache = newCache();
    const raw = mock();
    const model = resolveModel(raw, { cache });

    const a = await generateText({ model, prompt: "review this" });
    const b = await generateText({ model, prompt: "review this" });
    expect(raw.doGenerateCalls).toHaveLength(1);
    expect(b.text).toBe(a.text);
    expect(b.usage.inputTokens).toBe(100);
    expect(readdirSync(cache.dir)).toHaveLength(1);
  });

  it("survives a new cache instance and a new model object (disk-backed)", async () => {
    const cache = newCache();
    await generateText({ model: resolveModel(mock(), { cache }), prompt: "p" });
    const raw2 = mock();
    await generateText({ model: resolveModel(raw2, { cache: new LlmCache(cache.dir) }), prompt: "p" });
    expect(raw2.doGenerateCalls).toHaveLength(0);
  });

  it("changing the prompt, the system prompt, the params or the model invalidates", async () => {
    const cache = newCache();
    const raw = mock();
    const model = resolveModel(raw, { cache });
    await generateText({ model, prompt: "one" });
    await generateText({ model, prompt: "two" });
    await generateText({ model, prompt: "one", instructions: "be terse" });
    await generateText({ model, prompt: "one", temperature: 0.5 });
    expect(raw.doGenerateCalls).toHaveLength(4);

    const other = mock("other-model");
    await generateText({ model: resolveModel(other, { cache }), prompt: "one" });
    expect(other.doGenerateCalls).toHaveLength(1);
  });

  it("the tool schema is part of the key", async () => {
    const cache = newCache();
    const raw = mock();
    const model = resolveModel(raw, { cache });
    const withTool = (field: string) => ({
      t: tool({ description: "d", inputSchema: z.object({ [field]: z.string() }), execute: async () => "x" }),
    });
    await generateText({ model, prompt: "p", tools: withTool("a") });
    await generateText({ model, prompt: "p", tools: withTool("a") });
    await generateText({ model, prompt: "p", tools: withTool("b") });
    expect(raw.doGenerateCalls).toHaveLength(2);
  });

  it("a hit is recorded as cached and costs nothing", async () => {
    const cache = newCache();
    const tracker = new CostTracker({ maxTokens: 10_000 });
    const model = resolveModel(mock(), { cache, tracker });
    await generateText({ model, prompt: "p" });
    await generateText({ model, prompt: "p" });
    const s = tracker.snapshot();
    expect(s.calls).toBe(1);
    expect(s.cachedCalls).toBe(1);
    expect(s.totalTokens).toBe(120); // only the real call counts
  });

  it("key ignores abortSignal/headers but not the model spec", () => {
    const base = { prompt: [{ role: "user", content: "x" }] };
    expect(llmCacheKey("m", { ...base, headers: { a: "1" } })).toBe(llmCacheKey("m", base));
    expect(llmCacheKey("m", base)).not.toBe(llmCacheKey("n", base));
  });
});
