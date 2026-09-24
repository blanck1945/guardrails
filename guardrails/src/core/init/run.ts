import type { LanguageModel } from "ai";
import type { UsageTotals } from "../agent/budget";
import type { CostTracker } from "../cost";
import { safeParseConfig } from "../config";
import type { Workspace } from "../workspace";
import { collectRepoContext, type RepoContext } from "./collect";
import { validateScopes, type ScopeWarning } from "./scopes";
import { filterCandidates, type FilteredCandidates, type FilterOptions } from "./filter";
import { synthesizeRules, type CandidateRule } from "./synthesize";
import { mergeSuggestions, type MergeSuggestionsResult } from "./write";

export interface InitOptions extends FilterOptions {
  workspace: Workspace;
  model?: LanguageModel;
  /** Current `.guardrails/rules.md` contents, if any. */
  existingRulesMd?: string | null;
  /** Current `.guardrails/config.json` contents, if any. */
  existingConfigJson?: string | null;
  abortSignal?: AbortSignal;
  /** Counts spend and stops the run (`BudgetExceededError`) when its cap is reached. */
  costTracker?: CostTracker;
}

export interface InitResult {
  context: RepoContext;
  candidates: CandidateRule[];
  /** Rules whose scopes did not match the repo (repaired, dropped, or left without scope). */
  scopeWarnings: ScopeWarning[];
  filtered: FilteredCandidates;
  merge: MergeSuggestionsResult;
  usage: UsageTotals;
  /** Estimated USD for the run; `null` when the model has no known price. */
  costUsd: number | null;
}

/** collect -> synthesize -> filter -> merge. Pure with respect to the disk: the caller writes `merge.text`. */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const context = await collectRepoContext(opts.workspace);
  const synthesized = await synthesizeRules(context, {
    model: opts.model,
    abortSignal: opts.abortSignal,
    costTracker: opts.costTracker,
  });
  const { usage, costUsd } = synthesized;
  // Scopes are checked against the real file list before confidence filtering, so dead globs lower confidence.
  const { candidates, scopeWarnings } = validateScopes(synthesized.candidates, context.trackedFiles ?? []);
  const filtered = filterCandidates(candidates, opts);
  const config = safeParseConfig(opts.existingConfigJson).config;
  const merge = mergeSuggestions(opts.existingRulesMd, filtered.kept, {
    configRules: config.rules,
    disabledRules: config.disabledRules,
  });
  return { context, candidates, scopeWarnings, filtered, merge, usage, costUsd };
}

export function formatInitReport(r: InitResult, opts: { write: boolean; rulesPath: string }): string {
  const L: string[] = [];
  L.push(`Sources read (${r.context.files.length}, ${r.context.totalChars} chars):`);
  for (const f of r.context.files) L.push(`  - ${f.path} [${f.kind}]${f.truncated ? " (truncated)" : ""}`);
  const skipped = r.context.skipped;
  if (skipped.length) L.push(`Skipped: ${skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);

  L.push("", `Suggested rules (${r.merge.added.length}):`);
  for (const a of r.merge.added) {
    L.push(`  + ${a.id} [${a.severity}] scope: ${a.scope.join(", ")} (source: ${a.source})`, `      ${a.rule.split("\n")[0]}`);
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
