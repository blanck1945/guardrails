import { generateText, Output, type LanguageModel } from "ai";
import { BudgetExceededError, costSince, type CostTracker } from "./cost";
import { runChecks, type CheckSkip, type PartialCheck } from "./checks";
import { parseUnifiedDiff } from "./diff";
import { defaultModelSpec, jsonOnlyInstruction, modelSpecOf, resolveModel } from "./models";
import { estimateCostUsd } from "./pricing";
import { samplingFor } from "./sampling";
import { runReviewAgent, type AgentRunResult } from "./agent/loop";
import { mergeRuns } from "./agent/passes";
import { describeMode, MODE_PRESETS, type ModePreset, type ModeSelection } from "./modes";
import type { RuleChecksMode } from "./agent/prompts";
import type { RuleCheck } from "./findings/schema";
import { emptyUsage, sumUsage, type UsageTotals } from "./agent/budget";
import type { GuardrailsConfig } from "./config";
import { capFindings, capFor, collapseByLocation } from "./findings/limits";
import { verifyAbsenceClaims } from "./findings/verify";
import { ruleType } from "./rules/merge";
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

/** A model finding this close (in lines) to a check finding of the same partial rule and file is a repeat. */
const NEARBY_LINES = 3;

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
  /** Temperature preferred by the review mode (`GUARDRAILS_TEMPERATURE` overrides it). */
  temperature?: number;
  /** Per-rule verdict pass: `off` (basic), `ask` (default), `require` (deep: one bounce for an incomplete report). */
  ruleChecks?: RuleChecksMode;
  /** Review mode (basic | standard | deep): steps, confidence threshold, cap, passes, temperature. Default: the `standard` preset. */
  reviewMode?: { preset: ModePreset; selection?: ModeSelection };
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
  /** Mechanical rule checks (no model): which rules were verified and what could not run. */
  checks: { ran: string[]; skipped: CheckSkip[]; findings: number };
  /** Set when the model part failed or ran out of budget/time; `findings` then holds only the check findings. */
  modelIncomplete?: "budget" | "timeout" | "error";
  /** Verdicts of the exhaustive per-rule pass (agent mode), when the model returned them. */
  ruleChecks?: RuleCheck[];
  /** Mode the review ran in and why (when the caller selected one). */
  modeSelection?: ModeSelection;
  /** Agent passes requested and how many of them failed (deep runs 2). */
  passes: number;
  passesFailed: number;
}

function classifyModelFailure(err: unknown, signal?: AbortSignal): "budget" | "timeout" | "error" {
  if (err instanceof BudgetExceededError) return "budget";
  if (signal?.aborted || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) return "timeout";
  return "error";
}

const FAILURE_TEXT = { budget: "it reached its spend limit", timeout: "it ran out of time", error: "it failed" } as const;

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
    temperature: temperatureOption,
    ruleChecks: ruleChecksOption,
    reviewMode,
  }: ReviewOptions,
): Promise<ReviewOutput> {
  const before = costTracker?.snapshot();
  const costOf = (usage: UsageTotals): number | null =>
    costTracker && before ? costSince(costTracker, before) : estimateCostUsd(modelSpecOf(model), usage);
  const preset = reviewMode?.preset ?? MODE_PRESETS.standard;
  const selection = reviewMode?.selection;
  // `basic` and `deep` set their own strictness; `standard` keeps whatever the repo configured.
  const strictness = preset.strictness ?? config.strictness;
  const runConfig = { ...config, strictness };
  const min = preset.minConfidence ?? MIN_CONFIDENCE[strictness as 1 | 2 | 3];
  const cap = preset.findingCap ?? capFor(strictness);
  const temperature = temperatureOption ?? preset.temperature;
  const ruleChecks = ruleChecksOption ?? preset.ruleChecks;
  // A finding may only cite a rule that was given to the model (active rules in `config.rules`).
  // A finding may only cite a rule that was given to the model (active rules in `config.rules`).
  // A finding that cites such a rule is exempt from the comment-type filter (a team rule about
  // comment language is a `style` finding, but the team opted into it); the confidence filter still applies.
  // Findings without a valid rule go through the normal type filter.
  const filterFindings = (fs: Finding[]) => {
    const dropped: ReviewOutput["dropped"] = [];
    const kept: Finding[] = [];
    const activeById = new Map(config.rules.filter((r) => r.status === "active").map((r) => [r.id, r]));
    for (const raw of stripUnknownRuleIds(fs, config.rules)) {
      const rule = raw.ruleId ? activeById.get(raw.ruleId) : undefined;
      const citesActiveRule = !!rule;
      // The rule decides the type of its own findings, not the model.
      const f = rule ? { ...raw, type: ruleType(rule) } : raw;
      if (f.confidence < min) dropped.push({ finding: f, reason: "low-confidence" });
      else if (!citesActiveRule && !config.commentTypes.includes(f.type)) dropped.push({ finding: f, reason: "comment-type-disabled" });
      else kept.push(f);
    }
    return { findings: kept, dropped };
  };

  // Mechanical checks run first and independently of the model; their findings are never filtered or capped.
  const checkOutcome = await runChecks({ rules: config.rules, files: parseUnifiedDiff(input.diff), workspace }).catch(() => ({
    findings: [] as Finding[],
    ran: [] as string[],
    exhaustive: [] as string[],
    partial: [] as PartialCheck[],
    skipped: [] as CheckSkip[],
  }));
  // Only exhaustive checks silence the model; a partial check leaves its rule to the model (minus the reported locations).
  const mechanical = new Set(checkOutcome.exhaustive);
  const partialChecks = checkOutcome.partial;
  const partialIds = new Set(partialChecks.map((p) => p.ruleId));
  const checkFindings = checkOutcome.findings;
  const checkKeys = new Set(checkFindings.map((f) => `${f.file}\0${f.ruleId}`));
  const partialLines = new Map<string, number[]>();
  for (const f of checkFindings) {
    if (!f.ruleId || !partialIds.has(f.ruleId)) continue;
    const key = `${f.file}\0${f.ruleId}`;
    partialLines.set(key, [...(partialLines.get(key) ?? []), f.line]);
  }
  /** A model finding repeats a check finding: same file and rule; for a partial rule also the same or a nearby line. */
  const repeatsCheck = (f: Finding): boolean => {
    if (!f.ruleId) return false;
    const key = `${f.file}\0${f.ruleId}`;
    if (!checkKeys.has(key)) return false;
    const lines = partialLines.get(key);
    return lines ? lines.some((l) => Math.abs(l - f.line) <= NEARBY_LINES) : true;
  };

  // Deterministic grounding: drop findings that claim a file is absent when the head tree has it.
  const verify = async (all: Finding[]) => {
    const tagged = all.map((f): Finding => ({ ...f, origin: "llm" }));
    // A model finding that repeats a mechanical check (same file, same rule) is noise.
    const fs = tagged.filter((f) => !repeatsCheck(f));
    const repeated = tagged.filter((f) => !fs.includes(f));
    const { findings, dropped } = filterFindings(fs);
    dropped.push(...repeated.map((finding) => ({ finding, reason: "duplicate" as const })));
    let kept = findings;
    if (workspace) {
      const v = await verifyAbsenceClaims(kept, workspace);
      kept = v.kept;
      dropped.push(...v.contradicted.map((c) => ({ finding: c.finding, reason: "contradicted-by-repo" as const })));
    }
    // Less noise per change: collapse findings piled on one line, then cap the total by strictness.
    const collapsed = collapseByLocation(kept, config.rules);
    const capped = capFindings(collapsed.kept, config.rules, cap);
    dropped.push(...collapsed.dropped, ...capped.dropped);
    const omitted = capped.dropped.length;
    return { findings: capped.kept, dropped, omitted };
  };
  const withOmitted = (summary: string, omitted: number) =>
    omitted ? `${summary}${summary ? " " : ""}(${omitted} lower-priority finding(s) omitted: over the review cap.)` : summary;

  const checksMeta = { ran: checkOutcome.ran, skipped: checkOutcome.skipped, findings: checkFindings.length };
  const withChecks = (summary: string, failure?: "budget" | "timeout" | "error", passesFailed = 0) => {
    const extra = [
      selection ? describeMode(selection) : "",
      passesFailed ? `${passesFailed} of ${preset.passes} review passes did not complete (time or budget); results come from the other pass and the mechanical checks.` : "",
      checkFindings.length ? `${checkFindings.length} finding(s) come from mechanical rule checks.` : "",
      failure ? `The model-based review did not complete (${FAILURE_TEXT[failure]}); only the mechanical check results are shown.` : "",
    ].filter(Boolean);
    return [summary, ...extra].filter(Boolean).join(" ");
  };

  const modelPart = async () => {
    if (mode === "agent") {
      if (!workspace) throw new Error("reviewDiff: mode 'agent' requires a workspace");
      const runOne = (focus?: "general" | "rules-and-logic") =>
        runReviewAgent({
          model,
          config: runConfig,
          workspace,
          input,
          abortSignal,
          costTracker,
          mechanicalRuleIds: mechanical,
          partialChecks,
          temperature,
          ruleChecks,
          focus,
          budget: { maxSteps: preset.maxSteps, maxInputTokens: preset.maxInputTokens },
        });
      let run: AgentRunResult;
      let passesFailed = 0;
      if (preset.passes === 2) {
        // Two independent passes at once (same deadline). A pass that fails or times out is dropped if the other completed.
        const settled = await Promise.allSettled([runOne("general"), runOne("rules-and-logic")]);
        const done = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
        if (!done.length) throw (settled[0] as PromiseRejectedResult).reason;
        passesFailed = settled.length - done.length;
        run = mergeRuns(done);
      } else run = await runOne();
      const v = await verify(run.findings);
      return { ...v, summary: run.notes ?? "", usage: run.usage, incomplete: run.incomplete, notes: run.notes, ruleChecks: run.ruleChecks, passesFailed, passes: preset.passes };
    }
    const result = await generateText({
      model: resolveModel(model, { tracker: costTracker }),
      output: Output.object({ schema: reviewResultSchema }),
      instructions: `${buildSystemPrompt(runConfig, mechanical, partialChecks)}

${jsonOnlyInstruction(REVIEW_EXAMPLE)}`,
      prompt: buildUserPrompt(input),
      ...samplingFor(model, temperature),
      abortSignal,
    });
    const usage = result.steps.length ? sumUsage(result.steps.map((s) => s.usage)) : emptyUsage();
    const v = await verify(result.output.findings);
    return { ...v, summary: result.output.summary, usage, incomplete: undefined, notes: undefined, ruleChecks: undefined, passesFailed: 0, passes: 1 };
  };

  let part: Awaited<ReturnType<typeof modelPart>>;
  let failure: "budget" | "timeout" | "error" | undefined;
  try {
    part = await modelPart();
  } catch (err) {
    // Without any check finding there is nothing to publish: the caller reports the failure as before.
    if (!checkFindings.length) throw err;
    failure = classifyModelFailure(err, abortSignal);
    part = { findings: [], dropped: [], omitted: 0, summary: "", usage: emptyUsage(), incomplete: true, notes: undefined, ruleChecks: undefined, passesFailed: 0, passes: 1 };
  }
  return {
    summary: withChecks(withOmitted(part.summary, part.omitted), failure, part.passesFailed),
    findings: [...checkFindings, ...part.findings],
    dropped: part.dropped,
    mode,
    usage: part.usage,
    costUsd: costOf(part.usage),
    ...(part.incomplete !== undefined ? { incomplete: part.incomplete } : {}),
    ...(part.notes !== undefined ? { notes: part.notes } : {}),
    ...(part.ruleChecks ? { ruleChecks: part.ruleChecks } : {}),
    checks: checksMeta,
    ...(selection ? { modeSelection: selection } : {}),
    passes: part.passes,
    passesFailed: part.passesFailed,
    ...(failure ? { modelIncomplete: failure } : {}),
  };
}
