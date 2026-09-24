import type { LanguageModel } from "ai";
import type { UsageTotals } from "../agent/budget";
import type { CostTracker } from "../cost";
import { safeParseConfig } from "../config";
import type { Workspace } from "../workspace";
import { collectRepoContext, type RepoContext } from "./collect";
import { validateChecks, type CheckWarning } from "./checks";
import { validateScopes, type ScopeWarning } from "./scopes";
import { filterCandidates, type FilteredCandidates, type FilterOptions } from "./filter";
import { synthesizeRules, type CandidateRule } from "./synthesize";
import { mergeSuggestions, type MergeSuggestionsResult } from "./write";

export type InitStage = "collect" | "synthesize" | "filter" | "write";

/** Default wall-clock limit for the whole run (seconds). */
export const DEFAULT_INIT_TIMEOUT_SEC = 180;

export class InitTimeoutError extends Error {
  constructor(
    readonly timeoutSec: number,
    readonly stage: InitStage,
  ) {
    super(
      `init timed out after ${timeoutSec}s while running the "${stage}" stage; the model call was cancelled and nothing was written. ` +
        `Raise --timeout-sec, or use a faster model (--model).`,
    );
    this.name = "InitTimeoutError";
  }
}

export interface InitOptions extends FilterOptions {
  workspace: Workspace;
  model?: LanguageModel;
  /** Current `.guardrails/rules.md` contents, if any. */
  existingRulesMd?: string | null;
  /** Current `.guardrails/config.json` contents, if any. */
  existingConfigJson?: string | null;
  abortSignal?: AbortSignal;
  /** Wall-clock limit for collect + synthesize + filter, in seconds. Default `DEFAULT_INIT_TIMEOUT_SEC`; 0 = none. */
  timeoutSec?: number;
  /** Called at the end of each stage with its duration (for progress output). */
  onProgress?: (stage: InitStage, info: { ms: number; detail: string }) => void;
  /** Counts spend and stops the run (`BudgetExceededError`) when its cap is reached. */
  costTracker?: CostTracker;
}

export interface InitResult {
  context: RepoContext;
  candidates: CandidateRule[];
  /** Rules whose scopes did not match the repo (repaired, dropped, or left without scope). */
  scopeWarnings: ScopeWarning[];
  /** Proposed `check:` values that were invalid and discarded (the rule is kept without its check). */
  checkWarnings: CheckWarning[];
  filtered: FilteredCandidates;
  merge: MergeSuggestionsResult;
  usage: UsageTotals;
  /** Estimated USD for the run; `null` when the model has no known price. */
  costUsd: number | null;
}

/** collect -> synthesize -> filter -> merge. Pure with respect to the disk: the caller writes `merge.text`. */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_INIT_TIMEOUT_SEC;
  const timeout = new AbortController();
  const timer = timeoutSec > 0 ? setTimeout(() => timeout.abort(), timeoutSec * 1000) : undefined;
  const signal = opts.abortSignal ? AbortSignal.any([opts.abortSignal, timeout.signal]) : timeout.signal;
  let stage: InitStage = "collect";
  const done = (st: InitStage, t0: number, detail: string) => opts.onProgress?.(st, { ms: Date.now() - t0, detail });
  try {
    let t0 = Date.now();
    const context = await collectRepoContext(opts.workspace);
    done("collect", t0, `${context.files.length} source file(s), ${context.totalChars} chars`);

    stage = "synthesize";
    t0 = Date.now();
    const synthesized = await synthesizeRules(context, { model: opts.model, abortSignal: signal, costTracker: opts.costTracker });
    const { usage, costUsd } = synthesized;
    done("synthesize", t0, `${synthesized.candidates.length} candidate rule(s), ${usage.outputTokens} output tokens`);

    stage = "filter";
    t0 = Date.now();
    // Scopes are checked against the real file list before confidence filtering, so dead globs lower confidence.
    const checked = validateChecks(synthesized.candidates);
    const { candidates, scopeWarnings } = validateScopes(checked.candidates, context.trackedFiles ?? []);
    const checkWarnings = checked.warnings;
    const filtered = filterCandidates(candidates, opts);
    const config = safeParseConfig(opts.existingConfigJson).config;
    const merge = mergeSuggestions(opts.existingRulesMd, filtered.kept, {
      configRules: config.rules,
      disabledRules: config.disabledRules,
    });
    done("filter", t0, `${merge.added.length} suggested, ${scopeWarnings.length} scope warning(s)`);
    return { context, candidates, scopeWarnings, checkWarnings, filtered, merge, usage, costUsd };
  } catch (err) {
    if (timeout.signal.aborted && !opts.abortSignal?.aborted) throw new InitTimeoutError(timeoutSec, stage);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function formatInitReport(r: InitResult, opts: { write: boolean; rulesPath: string }): string {
  const L: string[] = [];
  L.push(`Sources read (${r.context.files.length}, ${r.context.totalChars} chars):`);
  for (const f of r.context.files) L.push(`  - ${f.path} [${f.kind}]${f.truncated ? " (truncated)" : ""}`);
  const skipped = r.context.skipped;
  if (skipped.length) L.push(`Skipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);

  L.push("", `Suggested rules (${r.merge.added.length}):`);
  for (const a of r.merge.added) {
    L.push(`  + ${a.id} [${a.severity}/${a.type ?? "style"}] scope: ${a.scope.join(", ")} (source: ${a.source})${a.check ? ` check: ${a.check}` : ""}`, `      ${a.rule.split("\n")[0]}`);
  }
  if (!r.merge.added.length) L.push("  (none)");
  if (r.scopeWarnings.length) {
    L.push("", "Scope warnings (checked against tracked files):");
    for (const w of r.scopeWarnings) {
      const parts = [
        ...w.repaired.map((x) => `repaired ${x.from} -> ${x.to}`),
        ...w.dropped.map((x) => `dropped ${x} (matches no file)`),
        ...(w.noValidScope ? ["no valid scope left: fell back to ** with lower confidence"] : []),
      ];
      L.push(`  ! ${w.id}: ${parts.join("; ")}`);
    }
  }
  if (r.checkWarnings.length) {
    L.push("", "Check warnings (invalid check discarded, rule kept without it):");
    for (const w of r.checkWarnings) L.push(`  ! ${w.id}: "${w.check}": ${w.error}`);
  }
  if (r.merge.skipped.length) L.push(`Already present, left untouched: ${r.merge.skipped.map((s) => s.id).join(", ")}`);
  if (r.filtered.toolEnforced.length) {
    L.push("", "Already enforced by tooling (not suggested):");
    for (const c of r.filtered.toolEnforced) L.push(`  - ${c.id} (${c.source}): ${c.rule.split("\n")[0]}`);
  }
  if (r.filtered.lowConfidence.length) {
    L.push("", "Below the confidence threshold (not suggested):");
    for (const c of r.filtered.lowConfidence) L.push(`  - ${c.id} (${c.confidence.toFixed(2)}): ${c.rule.split("\n")[0]}`);
  }
  L.push("", `Usage: ${r.usage.inputTokens} input (${r.usage.cachedInputTokens} cached) / ${r.usage.outputTokens} output tokens`);
  L.push(`Cost: ${r.costUsd === null ? "unknown (no known price for this model)" : `~$${r.costUsd.toFixed(4)}`}`);
  L.push(
    "",
    opts.write
      ? r.merge.added.length
        ? `Wrote ${opts.rulesPath}. New rules are "status: suggested": change them to "status: active" to enforce them.`
        : `No changes to ${opts.rulesPath}.`
      : "Dry run. Re-run with --write to append these to " + opts.rulesPath + " as suggested rules.",
  );
  return L.join("\n");
}
