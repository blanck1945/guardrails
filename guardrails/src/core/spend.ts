import { estimateCostUsd, type PricedUsage } from "./pricing";

/** Assumed average size of one model run, used to estimate a suite before spending anything. */
export interface RunProfile {
  /** Accumulated input tokens per run (cached reads included). */
  inputTokens: number;
  outputTokens: number;
  /** Share of the input served from the prompt cache. */
  cachedShare: number;
  /** What the numbers are based on. */
  basis: string;
}

/** Averages from PLAN-DETAILED §9 (F1 general agent, medium PR) and the init synthesizer. */
export const PROFILES = {
  single: { inputTokens: 12_000, outputTokens: 1_500, cachedShare: 0, basis: "PLAN §9 small-PR prefix + report" },
  agent: { inputTokens: 273_000, outputTokens: 4_700, cachedShare: 0.75, basis: "PLAN §9 F1 medium PR (8 files, 8 steps)" },
  init: { inputTokens: 30_000, outputTokens: 4_000, cachedShare: 0, basis: "one structured call over the collected docs" },
} as const satisfies Record<string, RunProfile>;

export type ProfileName = keyof typeof PROFILES;

/**
 * Calibration of `profileFromDiff` (v0.7.4). Measured on `zai:glm-5.3` with the local CLI, small PRs of 2 to 3
 * files: `standard` cost US$0.004 to 0.018 per review, `deep` (2 passes) US$0.022 to 0.043 (CHANGELOG v0.7.2 and
 * v0.7.3). The fixed `agent` profile above printed about US$0.17 per run, about 10 times too much for those PRs.
 * These constants come from a handful of runs: they are an order-of-magnitude estimate, not a quote.
 */
export const DIFF_ESTIMATE = {
  /** Rules, system prompt and tool definitions sent on every run. */
  overheadTokens: 3_000,
  /** Characters per token used for the diff text. */
  charsPerToken: 4,
  /** How many extra times the diff is re-read as the agent's context grows, by mode. */
  rereadSteps: { single: 0, basic: 1, standard: 3, deep: 6 },
  /** Output tokens: a fixed part (summary, verdicts) plus a part per changed file, capped. */
  outputBaseTokens: 500,
  outputPerFileTokens: 300,
  outputMaxTokens: 6_000,
  /** Share of the input served from the prompt cache in agent modes (single mode has no cache). */
  agentCachedShare: 0.5,
} as const;

export type DiffEstimateMode = keyof typeof DIFF_ESTIMATE.rereadSteps;

/** Profile of ONE run (one pass) sized from the real diff: use `runs = number of passes` with `estimateRun`. */
export function profileFromDiff(diffChars: number, fileCount: number, mode: DiffEstimateMode): RunProfile {
  const c = DIFF_ESTIMATE;
  const diffTokens = Math.ceil(Math.max(0, diffChars) / c.charsPerToken);
  const steps = c.rereadSteps[mode];
  const output = Math.min(c.outputMaxTokens, c.outputBaseTokens + c.outputPerFileTokens * Math.max(0, fileCount));
  return {
    inputTokens: c.overheadTokens + diffTokens * (1 + steps),
    outputTokens: output,
    cachedShare: mode === "single" ? 0 : c.agentCachedShare,
    basis: `diff of ${diffChars} chars in ${fileCount} file(s), ${mode} mode (calibrated on a few runs)`,
  };
}

/** Above this estimate a non-interactive run needs `--budget-usd` or `--yes`. */
export const CONFIRM_THRESHOLD_USD = 1;

export interface RunEstimate {
  modelSpec: string;
  runs: number;
  profile: RunProfile;
  /** `null` when the model has no known price. */
  usd: number | null;
  totalTokens: number;
}

export function estimateRun(modelSpec: string, runs: number, profile: RunProfile | ProfileName): RunEstimate {
  const p: RunProfile = typeof profile === "string" ? PROFILES[profile] : profile;
  const usage: PricedUsage = {
    inputTokens: p.inputTokens * runs,
    cachedInputTokens: Math.round(p.inputTokens * p.cachedShare) * runs,
    outputTokens: p.outputTokens * runs,
  };
  return { modelSpec, runs, profile: p, usd: estimateCostUsd(modelSpec, usage), totalTokens: usage.inputTokens + usage.outputTokens };
}

export function formatEstimate(e: RunEstimate): string {
  const cost = e.usd === null ? `unknown (no known price for "${e.modelSpec}")` : `~$${e.usd.toFixed(4)}`;
  return [
    `Estimate for ${e.runs} run(s) on ${e.modelSpec}: ${cost}`,
    `  assumed per run: ${e.profile.inputTokens} input tokens (${Math.round(e.profile.cachedShare * 100)}% cached), ${e.profile.outputTokens} output tokens (${e.profile.basis})`,
    `  total tokens: ${e.totalTokens}`,
  ].join("\n");
}

export interface SpendPlanInput {
  estimate: RunEstimate;
  budgetUsd?: number | undefined;
  yes?: boolean | undefined;
  dryRun?: boolean | undefined;
  /** Whether a human can answer prompts (TTY). */
  interactive: boolean;
}

export interface SpendPlan {
  action: "dry-run" | "refuse" | "run";
  /** Printed for `dry-run` and `refuse`; may carry a warning for `run`. */
  message: string;
}

/** Decides whether a spending command may start. Pure: the caller prints and exits. */
export function planSpend({ estimate, budgetUsd, yes, dryRun, interactive }: SpendPlanInput): SpendPlan {
  const text = formatEstimate(estimate);
  if (dryRun) return { action: "dry-run", message: `${text}\nDry run: no model was called.` };
  const guarded = budgetUsd !== undefined || yes === true;
  const expensive = estimate.usd === null || estimate.usd > CONFIRM_THRESHOLD_USD;
  if (expensive && !guarded && !interactive) {
    const why =
      estimate.usd === null
        ? "the cost cannot be estimated for this model"
        : `the estimate is above $${CONFIRM_THRESHOLD_USD}`;
    return {
      action: "refuse",
      message: `${text}\nRefusing to run non-interactively: ${why}. Re-run with --budget-usd <N> to cap spend, --yes to accept, or --dry-run to only see the estimate.`,
    };
  }
  return { action: "run", message: text };
}
