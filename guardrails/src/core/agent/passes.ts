import { BOTH_PASSES_BOOST, mergeAcrossPasses } from "../findings/dedupe";

export { BOTH_PASSES_BOOST };
import type { FileDiff } from "../diff";
import type { FindingV2, RuleCheck } from "../findings";
import { emptyUsage, type UsageTotals } from "./budget";
import type { AgentRunResult } from "./loop";

/**
 * Union of the findings of independent passes: one problem, one finding (see `mergeAcrossPasses`). A finding
 * found by more than one pass keeps the better version with its evidence united, its other locations listed in
 * the body and its confidence raised by 0.1.
 */
export function mergeFindings(passes: readonly (readonly FindingV2[])[]): FindingV2[] {
  return mergeAcrossPasses(passes).findings;
}

export function addUsage(list: readonly UsageTotals[]): UsageTotals {
  const t = emptyUsage();
  for (const u of list) {
    t.inputTokens += u.inputTokens;
    t.cachedInputTokens += u.cachedInputTokens;
    t.outputTokens += u.outputTokens;
    t.steps += u.steps;
  }
  return t;
}

function mergeRuleChecks(lists: readonly (readonly RuleCheck[] | undefined)[]): RuleCheck[] | undefined {
  const all = lists.flatMap((l) => l ?? []);
  if (!all.length) return undefined;
  const byKey = new Map<string, RuleCheck>();
  for (const c of all) {
    const k = `${c.ruleId}\0${c.file ?? ""}`;
    const prev = byKey.get(k);
    // A violation seen by any pass stands.
    if (!prev || (c.verdict === "violated" && prev.verdict !== "violated")) byKey.set(k, c);
  }
  return [...byKey.values()];
}

/** Combines the results of the passes that completed (at least one) into one run result. */
export function mergeRuns(runs: readonly AgentRunResult[], diffFiles?: readonly FileDiff[]): AgentRunResult & { merged: number } {
  const notes = [...new Set(runs.flatMap((r) => (r.notes ? r.notes.split("; ") : [])))].join("; ");
  const ruleChecks = mergeRuleChecks(runs.map((r) => r.ruleChecks));
  const union = mergeAcrossPasses(runs.map((r) => r.findings), diffFiles ? { diffFiles } : {});
  return {
    findings: union.findings,
    merged: union.merged,
    notes: notes || undefined,
    usage: addUsage(runs.map((r) => r.usage)),
    incomplete: runs.every((r) => r.incomplete),
    invalidReports: runs.reduce((n, r) => n + r.invalidReports, 0),
    forcedWrapUp: runs.some((r) => r.forcedWrapUp),
    ...(ruleChecks ? { ruleChecks } : {}),
  };
}
