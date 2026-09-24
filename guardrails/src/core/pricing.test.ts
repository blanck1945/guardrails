import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor, PRICES } from "./pricing";

describe("estimateCostUsd", () => {
  it("prices plain input and output per million tokens", () => {
    // glm-4.5-air: $0.2 in, $1.1 out
    const usd = estimateCostUsd("zai:glm-4.5-air", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(usd).toBeCloseTo(1.3, 10);
  });

  it("bills cached reads at the cache rate and the rest at the input rate", () => {
    // sonnet 5: $2 in, $0.2 read, $10 out
    const usd = estimateCostUsd("anthropic/claude-sonnet-5", {
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 100_000,
    });
    expect(usd).toBeCloseTo(0.2 * 2 + 0.8 * 0.2 + 0.1 * 10, 10);
  });

  it("returns null (never 0) for a model that is not in the table", () => {
    expect(estimateCostUsd("zai:glm-99", { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
    expect(estimateCostUsd("openai/gpt-x", { inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("marks every row with a verification date and a source", () => {
    for (const [spec, p] of Object.entries(PRICES)) {
      expect(p.verified, spec).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.source, spec).toMatch(/^https:\/\//);
    }
    expect(priceFor("ZAI:GLM-4.5-AIR")).not.toBeNull();
  });
});
