import { generateObject } from "ai";
import type { GuardrailsConfig } from "./config";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import { reviewResultSchema, type ReviewInput, type ReviewResult } from "./types";

const MIN_CONFIDENCE = { 1: 0.8, 2: 0.6, 3: 0.4 } as const;

export interface ReviewOptions {
  config: GuardrailsConfig;
  model?: string;
}

/**
 * Core of the product. Knows nothing about GitHub, so the cloud worker
 * and a future local CLI can both wrap it.
 */
export async function reviewDiff(
  input: ReviewInput,
  { config, model = process.env.GUARDRAILS_MODEL ?? "anthropic/claude-sonnet-5" }: ReviewOptions,
): Promise<ReviewResult> {
  const { object } = await generateObject({
    model,
    schema: reviewResultSchema,
    system: buildSystemPrompt(config),
    prompt: buildUserPrompt(input),
  });

  const min = MIN_CONFIDENCE[config.strictness as 1 | 2 | 3];
  return {
    summary: object.summary,
    findings: object.findings.filter(
      (f) => f.confidence >= min && config.commentTypes.includes(f.type),
    ),
  };
}
