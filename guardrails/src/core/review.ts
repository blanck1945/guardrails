import { generateText, Output, type LanguageModel } from "ai";
import { runReviewAgent } from "./agent/loop";
import { emptyUsage, sumUsage, type UsageTotals } from "./agent/budget";
import type { GuardrailsConfig } from "./config";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import { reviewResultSchema, type Finding, type ReviewInput } from "./types";
import type { Workspace } from "./workspace";

const MIN_CONFIDENCE = { 1: 0.8, 2: 0.6, 3: 0.4 } as const;
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

export type ReviewMode = "single" | "agent";

export interface ReviewOptions {
  config: GuardrailsConfig;
  /** Gateway model id or a `LanguageModel` instance. */
  model?: LanguageModel;
  /** `single` = one call, no tools (eval baseline). `agent` = tool loop; needs `workspace`. */
  mode?: ReviewMode;
  workspace?: Workspace;
  abortSignal?: AbortSignal;
}

export interface ReviewOutput {
  summary: string;
  /** Agent findings follow schema v2 (a superset of the v1 `Finding`). */
  findings: Finding[];
  mode: ReviewMode;
  usage: UsageTotals;
  /** Agent mode only: the model never produced a valid report. */
  incomplete?: boolean;
  notes?: string | undefined;
}

/**
 * Core of the product. Knows nothing about GitHub, so the cloud worker
 * and a future local CLI can both wrap it.
 */
export async function reviewDiff(
  input: ReviewInput,
  {
    config,
    model = process.env.GUARDRAILS_MODEL ?? DEFAULT_MODEL,
    mode = "single",
    workspace,
    abortSignal,
  }: ReviewOptions,
): Promise<ReviewOutput> {
  const min = MIN_CONFIDENCE[config.strictness as 1 | 2 | 3];
  const keep = (f: Finding) => f.confidence >= min && config.commentTypes.includes(f.type);

  if (mode === "agent") {
    if (!workspace) throw new Error("reviewDiff: mode 'agent' requires a workspace");
    const run = await runReviewAgent({ model, config, workspace, input, abortSignal });
    return {
      summary: run.notes ?? "",
      findings: run.findings.filter(keep),
      mode,
      usage: run.usage,
      incomplete: run.incomplete,
      notes: run.notes,
    };
  }

  const result = await generateText({
    model,
    output: Output.object({ schema: reviewResultSchema }),
    instructions: buildSystemPrompt(config),
    prompt: buildUserPrompt(input),
    abortSignal,
  });

  return {
    summary: result.output.summary,
    findings: result.output.findings.filter(keep),
    mode,
    usage: result.steps.length ? sumUsage(result.steps.map((s) => s.usage)) : emptyUsage(),
  };
}
