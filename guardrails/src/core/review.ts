import { generateText, Output, type LanguageModel } from "ai";
import { costSince, type CostTracker } from "./cost";
import { defaultModelSpec, modelSpecOf, resolveModel } from "./models";
import { estimateCostUsd } from "./pricing";
import { runReviewAgent } from "./agent/loop";
import { emptyUsage, sumUsage, type UsageTotals } from "./agent/budget";
import type { GuardrailsConfig } from "./config";
import { stripUnknownRuleIds } from "./rules/select";
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
  /** Findings the model reported but that were filtered out, with the reason. */
  dropped: { finding: Finding; reason: "low-confidence" | "comment-type-disabled" }[];
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
  // A finding may only cite a rule that was given to the model (active rules in `config.rules`).
  const filterFindings = (fs: Finding[]) => {
    const dropped: ReviewOutput["dropped"] = [];
    const basic: Finding[] = [];
    for (const f of fs) {
      if (f.confidence < min) dropped.push({ finding: f, reason: "low-confidence" });
      else if (!config.commentTypes.includes(f.type)) dropped.push({ finding: f, reason: "comment-type-disabled" });
      else basic.push(f);
    }
    return { findings: stripUnknownRuleIds(basic, config.rules), dropped };
  };

  if (mode === "agent") {
    if (!workspace) throw new Error("reviewDiff: mode 'agent' requires a workspace");
    const run = await runReviewAgent({ model, config, workspace, input, abortSignal, costTracker });
    const { findings, dropped } = filterFindings(run.findings);
    return {
      summary: run.notes ?? "",
      findings,
      dropped,
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
  const { findings, dropped } = filterFindings(result.output.findings);
  return {
    summary: result.output.summary,
    findings,
    dropped,
    mode,
    usage,
    costUsd: costOf(usage),
  };
}
