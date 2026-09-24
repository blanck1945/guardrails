import type { LanguageModel } from "ai";
import type { UsageTotals } from "../agent/budget";
import { safeParseConfig } from "../config";
import type { Workspace } from "../workspace";
import { collectRepoContext, type RepoContext } from "./collect";
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
}

export interface InitResult {
  context: RepoContext;
  candidates: CandidateRule[];
  filtered: FilteredCandidates;
  merge: MergeSuggestionsResult;
  usage: UsageTotals;
}

/** collect -> synthesize -> filter -> merge. Pure with respect to the disk: the caller writes `merge.text`. */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const context = await collectRepoContext(opts.workspace);
  const { candidates, usage } = await synthesizeRules(context, { model: opts.model, abortSignal: opts.abortSignal });
  const filtered = filterCandidates(candidates, opts);
  const config = safeParseConfig(opts.existingConfigJson).config;
  const merge = mergeSuggestions(opts.existingRulesMd, filtered.kept, {
    configRules: config.rules,
    disabledRules: config.disabledRules,
  });
  return { context, candidates, filtered, merge, usage };
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
  if (r.merge.skipped.length) L.push(`Already present, left untouched: ${r.merge.skipped.map((s) => s.id).join(", ")}`);
  if (r.filtered.toolEnforced.length) {
    L.push("", "Already enforced by tooling (not suggested):");
    for (const c of r.filtered.toolEnforced) L.push(`  - ${c.id} (${c.source}): ${c.rule.split("\n")[0]}`);
  }
  if (r.filtered.lowConfidence.length) {
    L.push("", "Below the confidence threshold (not suggested):");
    for (const c of r.filtered.lowConfidence) L.push(`  - ${c.id} (${c.confidence.toFixed(2)}): ${c.rule.split("\n")[0]}`);
  }
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
