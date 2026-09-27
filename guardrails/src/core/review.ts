import { generateText, Output, type LanguageModel } from "ai";
import { BudgetExceededError, costSince, type CostTracker } from "./cost";
import { runChecks, type CheckSkip, type PartialCheck } from "./checks";
import { parseUnifiedDiff } from "./diff";
import { defaultModelSpec, jsonOnlyInstruction, modelSpecOf, resolveModel } from "./models";
import { estimateCostUsd } from "./pricing";
import { samplingFor } from "./sampling";
import { runReviewAgent, type AgentRunResult } from "./agent/loop";
import { mergeRuns } from "./agent/passes";
import { messages } from "./i18n";
import { describeMode, MODE_PRESETS, type ModePreset, type ModeSelection } from "./modes";
import type { RuleChecksMode } from "./agent/prompts";
import type { RuleCheck } from "./findings/schema";
import { emptyUsage, sumUsage, type UsageTotals } from "./agent/budget";
import type { GuardrailsConfig } from "./config";
import { mergeModelIntoChecks, ruleFileKey } from "./findings/check-merge";
import { capFindings, capFor, collapseByLocation } from "./findings/limits";
import { verifyAbsenceClaims } from "./findings/verify";
import { snapAnchors } from "./findings/anchor";
import { computeCoverage, type Coverage, type CoverageContext, type DropReason } from "./coverage";
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
  /** Extra facts for the coverage report that only the caller knows (all changed files, fallback). Never changes findings. */
  coverage?: CoverageContext;
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
  dropped: { finding: Finding; reason: DropReason }[];
  /** Mechanical rule checks (no model): which rules were verified (`exhaustive`, `partial`) and what could not run. */
  checks: { ran: string[]; skipped: CheckSkip[]; findings: number; exhaustive: string[]; partial: string[] };
  /** Agent mode: the forced wrap-up step was triggered in at least one pass. */
  forcedWrapUp?: boolean;
  /** Distinct paths the agent read at the head revision (single mode: the full-file contexts given to the model). */
  filesOpened?: string[];
  /** What was actually examined (see `computeCoverage`). */
  coverage: Coverage;
  /** Set when the model part failed or ran out of budget/time; `findings` then holds only the check findings. */
  modelIncomplete?: "budget" | "timeout" | "error";
  /** Verdicts of the exhaustive per-rule pass (agent mode), when the model returned them. */
  ruleChecks?: RuleCheck[];
  /** Mode the review ran in and why (when the caller selected one). */
  modeSelection?: ModeSelection;
  /** Agent passes requested and how many of them failed (deep runs 2). */
  passes: number;
  passesFailed: number;
  /** Duplicates folded into another finding across deep passes. */
  merged: number;
  /** Lower-priority findings left out because of the review cap. */
  omitted: number;
  /** The model's own notes (agent) or summary (single), before any composition. */
  modelSummary: string;
}

function classifyModelFailure(err: unknown, signal?: AbortSignal): "budget" | "timeout" | "error" {
  if (err instanceof BudgetExceededError) return "budget";
  if (signal?.aborted || (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))) return "timeout";
  return "error";
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
    temperature: temperatureOption,
    ruleChecks: ruleChecksOption,
    reviewMode,
    coverage: coverageContext,
  }: ReviewOptions,
): Promise<ReviewOutput> {
  const lang = config.language;
  const msg = messages(lang).summary;
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
  const checkOutcome = await runChecks({ rules: config.rules, files: parseUnifiedDiff(input.checksDiff ?? input.diff), workspace, lang }).catch(() => ({
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
  const checkKeys = new Set(checkOutcome.findings.map((f) => ruleFileKey(f)));
  /** A model finding repeats a check finding when it has the same file and rule, whatever the distance. */
  const repeatsCheck = (f: Finding): boolean => !!f.ruleId && checkKeys.has(ruleFileKey(f));
  /** Repeats of a partial rule are folded into the closest check finding (v0.8.1); those of an exhaustive rule are just dropped. */
  const foldsIntoCheck = (f: Finding): boolean => !!f.ruleId && partialIds.has(f.ruleId);
  const foldedIntoChecks: Finding[] = [];

  // Deterministic grounding: drop findings that claim a file is absent when the head tree has it.
  const verify = async (all: Finding[]) => {
    const tagged = all.map((f): Finding => ({ ...f, origin: "llm" }));
    // A model finding that repeats a mechanical check (same file, same rule) is noise.
    const fs = tagged.filter((f) => !repeatsCheck(f));
    const repeated = tagged.filter((f) => !fs.includes(f));
    foldedIntoChecks.push(...repeated.filter(foldsIntoCheck));
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
  const diffFiles = parseUnifiedDiff(input.diff);
  // Each finding is moved to the added line that holds the text it quotes, before passes are merged.
  const snap = <T extends Finding>(fs: T[]): T[] => snapAnchors(fs, diffFiles);
  const withOmitted = (summary: string, omitted: number) =>
    omitted ? `${summary}${summary ? " " : ""}(${msg.omitted(omitted)})` : summary;

  const checksMeta = { ran: checkOutcome.ran, skipped: checkOutcome.skipped, findings: checkFindings.length, exhaustive: checkOutcome.exhaustive, partial: checkOutcome.partial.map((p) => p.ruleId) };
  const withChecks = (summary: string, failure?: "budget" | "timeout" | "error", passesFailed = 0) => {
    const extra = [
      selection ? describeMode(selection, lang) : "",
      passesFailed ? msg.passesFailed(passesFailed, preset.passes) : "",
      checkFindings.length ? msg.checkFindingsNote(checkFindings.length) : "",
      failure ? msg.modelFailed(failure) : "",
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
        }).then((r) => ({ ...r, findings: snap(r.findings) }));
      let run: AgentRunResult;
      let merged = 0;
      let passesFailed = 0;
      if (preset.passes === 2) {
        // Two independent passes at once (same deadline). A pass that fails or times out is dropped if the other completed.
        const settled = await Promise.allSettled([runOne("general"), runOne("rules-and-logic")]);
        const done = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
        if (!done.length) throw (settled[0] as PromiseRejectedResult).reason;
        passesFailed = settled.length - done.length;
        const union = mergeRuns(done, diffFiles, lang);
        merged = union.merged;
        run = union;
      } else run = await runOne();
      const v = await verify(run.findings);
      return { ...v, summary: run.notes ?? "", usage: run.usage, incomplete: run.incomplete, notes: run.notes, ruleChecks: run.ruleChecks, passesFailed, passes: preset.passes, merged, forcedWrapUp: run.forcedWrapUp, filesOpened: run.filesOpened };
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
    const v = await verify(snap(result.output.findings));
    return { ...v, summary: result.output.summary, usage, incomplete: undefined, notes: undefined, ruleChecks: undefined, passesFailed: 0, passes: 1, merged: 0, forcedWrapUp: false, filesOpened: Object.keys(input.context).sort() };
  };

  let part: Awaited<ReturnType<typeof modelPart>>;
  let failure: "budget" | "timeout" | "error" | undefined;
  try {
    part = await modelPart();
  } catch (err) {
    // Without any check finding there is nothing to publish: the caller reports the failure as before.
    if (!checkFindings.length) throw err;
    failure = classifyModelFailure(err, abortSignal);
    part = { findings: [], dropped: [], omitted: 0, summary: "", usage: emptyUsage(), incomplete: true, notes: undefined, ruleChecks: undefined, passesFailed: 0, passes: 1, merged: 0, forcedWrapUp: false, filesOpened: [] };
  }
  const modelIncomplete = failure;
  // v0.8.1: repeats of a partial check rule are listed in the check comment ("Also at line N"), whatever the distance.
  const publishedChecks = mergeModelIntoChecks(checkFindings, foldedIntoChecks, diffFiles, lang);
  const coverage = computeCoverage({
    files: coverageContext?.files ?? diffFiles.map((d) => ({ path: d.path, state: "in-input" as const })),
    rules: config.rules,
    ...(coverageContext?.rulesOutOfScope ? { rulesOutOfScopeExtra: coverageContext.rulesOutOfScope } : {}),
    engine: mode,
    ruleChecksMode: ruleChecks,
    checks: { ran: checkOutcome.ran, exhaustive: checkOutcome.exhaustive, partial: checksMeta.partial, skipped: checkOutcome.skipped },
    ruleChecks: part.ruleChecks,
    findings: [...publishedChecks, ...part.findings],
    dropped: part.dropped,
    modelIncomplete,
    incomplete: part.incomplete,
    passes: part.passes,
    passesFailed: part.passesFailed,
    forcedWrapUp: part.forcedWrapUp,
    notes: part.notes,
    filesOpened: part.filesOpened,
    steps: part.usage.steps,
    fallback: coverageContext?.fallback,
  });
  return {
    summary: withChecks(withOmitted(part.summary, part.omitted), failure, part.passesFailed),
    findings: [...publishedChecks, ...part.findings],
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
    merged: part.merged,
    omitted: part.omitted,
    modelSummary: part.summary,
    coverage,
    ...(mode === "agent" ? { forcedWrapUp: part.forcedWrapUp } : {}),
    filesOpened: part.filesOpened,
    ...(failure ? { modelIncomplete: failure } : {}),
  };
}
