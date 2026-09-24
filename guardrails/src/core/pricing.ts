import type { UsageTotals } from "./agent/budget";

/** USD per 1M tokens. `cacheRead`/`cacheWrite` fall back to `input` when absent. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** ISO date the price was checked against `source`. */
  verified: string;
  source: string;
  note?: string;
}

const VERIFIED = "2026-09-24";
const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const ZAI = "https://docs.z.ai/guides/overview/pricing";
const DEEPSEEK = "https://api-docs.deepseek.com/quick_start/pricing";

const sonnet5: ModelPrice = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, verified: VERIFIED, source: ANTHROPIC, note: "5m cache write; Gateway list price may differ" };
const haiku45: ModelPrice = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, verified: VERIFIED, source: ANTHROPIC, note: "5m cache write; Gateway list price may differ" };
const deepseekFlash: ModelPrice = { input: 0.3, output: 1.2, cacheRead: 0.006, verified: VERIFIED, source: DEEPSEEK, note: "peak-hour rate (off-peak is half); upper bound" };
const deepseekPro: ModelPrice = { input: 1.32, output: 3.96, cacheRead: 0.044, verified: VERIFIED, source: DEEPSEEK, note: "peak-hour rate (off-peak is half); upper bound" };

/** Keyed by the model spec string used in GUARDRAILS_MODEL / `--model`. */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "anthropic/claude-sonnet-5": sonnet5,
  "anthropic/claude-haiku-4.5": haiku45,
  "anthropic/claude-haiku-4-5": haiku45,
  "zai:glm-4.5-air": { input: 0.2, output: 1.1, cacheRead: 0.03, verified: VERIFIED, source: ZAI },
  "zai:glm-4.5": { input: 0.6, output: 2.2, cacheRead: 0.11, verified: VERIFIED, source: ZAI },
  "zai:glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, verified: VERIFIED, source: ZAI },
  "zai:glm-5.3-flashx": { input: 0.37, output: 1.25, cacheRead: 0.075, verified: VERIFIED, source: ZAI },
  "zai:glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, verified: VERIFIED, source: ZAI },
  "zai:glm-4.6": { input: 0.6, output: 2.2, cacheRead: 0.11, verified: VERIFIED, source: ZAI },
  "deepseek:deepseek-flash": deepseekFlash,
  "deepseek:deepseek-v4-flash": deepseekFlash, // legacy name, billed at the Flash price
  "deepseek:deepseek-v4-pro": deepseekPro,
};

export function priceFor(modelSpec: string): ModelPrice | null {
  return PRICES[modelSpec.trim().toLowerCase()] ?? null;
}

export interface PricedUsage {
  /** Total input tokens, cache reads/writes included (AI SDK convention). */
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  /** Total output tokens, reasoning included. */
  outputTokens: number;
}

/** Estimated cost in USD, or `null` when the model has no known price (never a fake 0). */
export function estimateCostUsd(modelSpec: string, usage: PricedUsage | UsageTotals): number | null {
  const p = priceFor(modelSpec);
  if (!p) return null;
  const read = usage.cachedInputTokens ?? 0;
  const write = "cacheWriteTokens" in usage ? (usage.cacheWriteTokens ?? 0) : 0;
  const plain = Math.max(0, usage.inputTokens - read - write);
  const usd =
    plain * p.input + read * (p.cacheRead ?? p.input) + write * (p.cacheWrite ?? p.input) + usage.outputTokens * p.output;
  return usd / 1_000_000;
}
