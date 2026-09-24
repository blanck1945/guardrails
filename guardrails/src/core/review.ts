import { generateText, Output, type LanguageModel } from "ai";
import { costSince, type CostTracker } from "./cost";
import { defaultModelSpec, modelSpecOf, resolveModel } from "./models";
import { estimateCostUsd } from "./pricing";
import { runReviewAgent } from "./agent/loop";
import { emptyUsage, sumUsage, type UsageTotals } from "./agent/budget";
import type { GuardrailsConfig } from "./config";
import { dropUnknownRuleFindings } from "./rules/select";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import { reviewResultSchema, type Finding, type ReviewInput } from "./types";
import type { Workspace } from "./workspace";

const MIN_CONFIDENCE = { 1: 0.8, 2: 0.6, 3: 0.4 } as const;

export type ReviewMode = "single" | "agent";

export interface ReviewOptions {
  config: GuardrailsConfig;
  /** Model spec (`zai:<id>`, `deepseek:<id>`, or a Gateway id) or a `LanguageModel` instance. */
  model?: LanguageModel;
  /** `single` = one call, no tools (eval baseline). `agent` = tool loop; needs `workspace`. */
  mode?: ReviewMode;
  workspace?: Workspace;
  abortSignal?: AbortSignal;
  /** Counts spend and stops the run (`BudgetExceededError`) when its cap is reached. */
  costTracker?: CostTracker;
}

export interface ReviewOutput {
  summary: string;
  /** Agent findings follow schema v2 (a superset of the v1 `Finding`). */
  findings: Finding[];
  mode: ReviewMode;
  usage: UsageTotals;
  /** Estimated USD for this review; `null` when the model has no known price. */
  costUsd: number | null;
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
    model = defaultModelSpec(),
    mode = "single",
    workspace,
    abortSignal,
    costTracker,
  }: ReviewOptions,
): Promise<ReviewOutput> {
  const before = costTracker?.snapshot();
  const costOf = (usage: UsageTotals): number | null =>
    costTracker && before ? costSince(costTracker, before) : estimateCostUsd(modelSpecOf(model), usage);
  const min = MIN_CONFIDENCE[config.strictness as 1 | 2 | 3];
  const keepBasic = (f: Finding) => f.confidence >= min && config.commentTypes.includes(f.type);
  // A finding may only cite a rule that was given to the model (active rules in `config.rules`).
  const filterFindings = (fs: Finding[]) => dropUnknownRuleFindings(fs.filter(keepBasic), config.rules);

  if (mode === "agent") {
    if (!workspace) throw new Error("reviewDiff: mode 'agent' requires a workspace");
    const run = await runReviewAgent({ model, config, workspace, input, abortSignal, costTracker });
    return {
      summary: run.notes ?? "",
      findings: filterFindings(run.findings),
      mode,
      usage: run.usage,
      costUsd: costOf(run.usage),
      incomplete: run.incomplete,
      notes: run.notes,
    };
  }

  const result = await generateText({
    model: resolveModel(model, { tracker: costTracker }),
    output: Output.object({ schema: reviewResultSchema }),
    instructions: buildSystemPrompt(config),
    prompt: buildUserPrompt(input),
    abortSignal,
  });

  const usage = result.steps.length ? sumUsage(result.steps.map((s) => s.usage)) : emptyUsage();
  return {
    summary: result.output.summary,
    findings: filterFindings(result.output.findings),
    mode,
    usage,
    costUsd: costOf(usage),
  };
}
