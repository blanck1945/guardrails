import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, CostTracker } from "./cost";
import { defaultConfig } from "./config";
import { resolveModel } from "./models";
import { reviewDiff } from "./review";

afterEach(() => vi.unstubAllGlobals());

/** Stubs the Z.ai chat endpoint; every call reports the given usage. Returns the call counter. */
function stubZai(promptTokens: number, completionTokens: number, content = "ok") {
  const counter = { calls: 0 };
  vi.stubGlobal("fetch", async () => {
    counter.calls += 1;
    return new Response(
      JSON.stringify({
        id: "x",
        created: 0,
        model: "glm-4.5-air",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return counter;
}

const env = { ZAI_API_KEY: "test-key" };

const mockWithUsage = (input: number, output: number, text = "ok") =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output, reasoning: 0 },
      },
      warnings: [],
    }),
  });

describe("CostTracker", () => {
  it("sums priced calls and stops once the USD cap is reached", async () => {
    // glm-4.5-air: 1M input tokens = $0.20 per call.
    const counter = stubZai(1_000_000, 0);
    const tracker = new CostTracker({ maxUsd: 0.5 });
    const model = resolveModel("zai:glm-4.5-air", { env, tracker });

    await generateText({ model, prompt: "a" });
    await generateText({ model, prompt: "b" });
    expect(tracker.snapshot().costUsd).toBeCloseTo(0.4, 10);
    // Third call is allowed to start ($0.40 < $0.50) and takes the total to $0.60.
    await expect(generateText({ model, prompt: "c" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(counter.calls).toBe(3);
    // A fourth call is refused before reaching the model.
    await expect(generateText({ model, prompt: "d" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(counter.calls).toBe(3);

    const s = tracker.snapshot();
    expect(s.costUsd).toBeCloseTo(0.6, 10);
    expect(s.calls).toBe(3);
    expect(s.complete).toBe(true);
  });

  it("caps on tokens (with a warning) when the model has no known price", async () => {
    const tracker = new CostTracker({ maxTokens: 1_000 });
    const model = resolveModel(mockWithUsage(400, 100), { tracker });

    await generateText({ model, prompt: "a" }); // 500 tokens
    expect(tracker.warnings).toHaveLength(1);
    expect(tracker.warnings[0]).toMatch(/No known price/);
    await expect(generateText({ model, prompt: "b" })).rejects.toBeInstanceOf(BudgetExceededError); // 1000 >= cap
    await expect(generateText({ model, prompt: "c" })).rejects.toThrow(/token limit/);

    const s = tracker.snapshot();
    expect(s.totalTokens).toBe(1_000);
    expect(s.costUsd).toBe(0);
    expect(s.complete).toBe(false); // unpriced tokens: 0 is not a real cost
    expect(tracker.warnings).toHaveLength(1); // warned once
  });

  it("derives a token cap from maxUsd when the model is unpriced", async () => {
    const tracker = new CostTracker({ maxUsd: 0.001 }); // ~1000 tokens at the fallback rate
    const model = resolveModel(mockWithUsage(900, 200), { tracker });
    await expect(generateText({ model, prompt: "a" })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(tracker.warnings[0]).toMatch(/1000 tokens/);
  });

  it("wraps a model only once", async () => {
    const tracker = new CostTracker({ maxUsd: 1 });
    const once = resolveModel(mockWithUsage(1, 1), { tracker });
    expect(resolveModel(once, { tracker })).toBe(once);
    await generateText({ model: resolveModel(once, { tracker }), prompt: "a" });
    expect(tracker.snapshot().calls).toBe(1);
  });
});

describe("reviewDiff cost reporting", () => {
  const input = { diff: "diff --git a/a.ts b/a.ts\n+x", context: {}, docs: {} };
  const report = JSON.stringify({ summary: "ok", findings: [] });

  it("reports costUsd from the tracker for a priced model", async () => {
    vi.stubEnv("ZAI_API_KEY", "test-key");
    stubZai(100_000, 10_000, report);
    const tracker = new CostTracker({ maxUsd: 1 });
    const r = await reviewDiff(input, { config: defaultConfig, model: "zai:glm-4.5-air", costTracker: tracker });
    // 100k * $0.2/M + 10k * $1.1/M = $0.031
    expect(r.costUsd).toBeCloseTo(0.031, 6);
    vi.unstubAllEnvs();
    expect(tracker.snapshot().costUsd).toBeCloseTo(0.031, 6);
  });

  it("reports costUsd without a tracker too, and null for an unknown model", async () => {
    stubZai(100_000, 10_000, report);
    vi.stubEnv("ZAI_API_KEY", "test-key");
    const priced = await reviewDiff(input, { config: defaultConfig, model: "zai:glm-4.5-air" });
    expect(priced.costUsd).toBeCloseTo(0.031, 6);
    vi.unstubAllEnvs();

    const unknown = await reviewDiff(input, { config: defaultConfig, model: mockWithUsage(10, 10, report) });
    expect(unknown.costUsd).toBeNull();
  });
});
