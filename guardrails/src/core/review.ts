import { generateText, Output, type LanguageModel } from "ai";
import { costSince, type CostTracker } from "./cost";
import { defaultModelSpec, jsonOnlyInstruction, modelSpecOf, resolveModel } from "./models";
import { estimateCostUsd } from "./pricing";
import { runReviewAgent } from "./agent/loop";
import { emptyUsage, sumUsage, type UsageTotals } from "./agent/budget";
import type { GuardrailsConfig } from "./config";
import { capFindings, capFor, collapseByLocation } from "./findings/limits";
import { verifyAbsenceClaims } from "./findings/verify";
import { stripUnknownRuleIds } from "./rules/select";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
import { reviewResultSchema, type Finding, type ReviewInput } from "./types";
import type { Workspace } from "./workspace";

const REVIEW_EXAMPLE = {
  summary: "One sentence.",
  findings: [
    { file: "src/a.ts", line: 12, type: "logic", severity: "medium", confidence: 0.8, title: "Short title", body: "What is wrong and why.", ruleId: "optional-rule-id" },
  ],
};

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
  dropped: { finding: Finding; reason: "low-confidence" | "comment-type-disabled" | "contradicted-by-repo" | "duplicate" | "over-cap" }[];
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
  // A finding may only cite a rule that was given to the model (active rules in `config.rules`).
  // A finding that cites such a rule is exempt from the comment-type filter (a team rule about
  // comment language is a `style` finding, but the team opted into it); the confidence filter still applies.
  // Findings without a valid rule go through the normal type filter.
  const filterFindings = (fs: Finding[]) => {
    const dropped: ReviewOutput["dropped"] = [];
    const kept: Finding[] = [];
    const activeIds = new Set(config.rules.filter((r) => r.status === "active").map((r) => r.id));
    for (const f of stripUnknownRuleIds(fs, config.rules)) {
      const citesActiveRule = !!f.ruleId && activeIds.has(f.ruleId);
      if (f.confidence < min) dropped.push({ finding: f, reason: "low-confidence" });
      else if (!citesActiveRule && !config.commentTypes.includes(f.type)) dropped.push({ finding: f, reason: "comment-type-disabled" });
      else kept.push(f);
    }
    return { findings: kept, dropped };
  };

  // Deterministic grounding: drop findings that claim a file is absent when the head tree has it.
  const verify = async (fs: Finding[]) => {
    const { findings, dropped } = filterFindings(fs);
    let kept = findings;
    if (workspace) {
      const v = await verifyAbsenceClaims(kept, workspace);
      kept = v.kept;
      dropped.push(...v.contradicted.map((c) => ({ finding: c.finding, reason: "contradicted-by-repo" as const })));
    }
    // Less noise per change: collapse findings piled on one line, then cap the total by strictness.
    const collapsed = collapseByLocation(kept, config.rules);
    const capped = capFindings(collapsed.kept, config.rules, capFor(config.strictness));
    dropped.push(...collapsed.dropped, ...capped.dropped);
    const omitted = capped.dropped.length;
    return { findings: capped.kept, dropped, omitted };
  };
  const withOmitted = (summary: string, omitted: number) =>
    omitted ? `${summary}${summary ? " " : ""}(${omitted} lower-priority finding(s) omitted: over the review cap.)` : summary;

  if (mode === "agent") {
    if (!workspace) throw new Error("reviewDiff: mode 'agent' requires a workspace");
    const run = await runReviewAgent({ model, config, workspace, input, abortSignal, costTracker });
    const { findings, dropped, omitted } = await verify(run.findings);
    return {
      summary: withOmitted(run.notes ?? "", omitted),
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
    instructions: `${buildSystemPrompt(config)}

${jsonOnlyInstruction(REVIEW_EXAMPLE)}`,
    prompt: buildUserPrompt(input),
    abortSignal,
  });

  const usage = result.steps.length ? sumUsage(result.steps.map((s) => s.usage)) : emptyUsage();
  const { findings, dropped, omitted } = await verify(result.output.findings);
  return {
    summary: withOmitted(result.output.summary, omitted),
    findings,
    dropped,
    mode,
    usage,
    costUsd: costOf(usage),
  };
}
