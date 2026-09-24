import type { LanguageModel } from "ai";
import { modelSpecOf } from "./models";
import type { Env } from "./llm-cache";

/** Sampling used by every review and init call. Fixed so runs of the same input vary as little as the provider allows. */
export const DEFAULT_TEMPERATURE = 0;
export const DEFAULT_SEED = 42;

export interface Sampling {
  temperature: number;
  /** Only present when the provider documents a `seed` parameter (or the user set `GUARDRAILS_SEED`). */
  seed?: number;
}

/**
 * Providers whose chat API documents `seed`. Z.ai does not: its chat-completion reference (docs.z.ai, verified 2026-09-24)
 * lists temperature, top_p, do_sample, max_tokens... and no seed, so it is never sent by default. DeepSeek's API does not document it either.
 * OpenAI models through the AI Gateway (`openai/...`) do. `GUARDRAILS_SEED` forces a seed for any provider.
 */
export function providerSupportsSeed(spec: string): boolean {
  return /^openai\//.test(spec);
}

function numberEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The single place that decides `temperature` and `seed`.
 * Temperature priority: `GUARDRAILS_TEMPERATURE` (env) > `preferred` (the review mode's preset) > 0.
 * Z.ai accepts [0, 1]; values outside the provider range are clamped.
 */
export function samplingFor(model: LanguageModel, preferred?: number, env: Env = process.env): Sampling {
  const spec = modelSpecOf(model);
  const fromEnv = numberEnv(env.GUARDRAILS_TEMPERATURE);
  let temperature = fromEnv ?? preferred ?? DEFAULT_TEMPERATURE;
  const max = spec.startsWith("zai:") ? 1 : 2;
  temperature = Math.min(max, Math.max(0, temperature));
  const envSeed = numberEnv(env.GUARDRAILS_SEED);
  const seed = envSeed !== undefined && Number.isInteger(envSeed) ? envSeed : providerSupportsSeed(spec) ? DEFAULT_SEED : undefined;
  return seed === undefined ? { temperature } : { temperature, seed };
}
