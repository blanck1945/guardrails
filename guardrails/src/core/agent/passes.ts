import { jaccard } from "../findings/dedupe";
import { normalizeTitle } from "../findings/fingerprint";
import type { FindingV2, RuleCheck } from "../findings";
import { emptyUsage, type UsageTotals } from "./budget";
import type { AgentRunResult } from "./loop";

/** Confidence added to a finding that two independent passes both reported (capped at 1). */
export const BOTH_PASSES_BOOST = 0.1;

const titleTokens = (t: string) => new Set(normalizeTitle(t).split(" ").filter(Boolean));

/** Same problem: same file, lines within 3, and the same rule or similar titles (Jaccard >= 0.5). */
export function sameFinding(a: FindingV2, b: FindingV2): boolean {
  if (a.file !== b.file || Math.abs(a.line - b.line) > 3) return false;
  if (a.ruleId && a.ruleId === b.ruleId && a.line === b.line) return true;
  return jaccard(titleTokens(a.title), titleTokens(b.title)) >= 0.5;
}

/**
 * Union of the findings of independent passes. A finding found by more than one pass keeps the better version
 * (higher severity, then confidence) with its evidence united and its confidence raised by `BOTH_PASSES_BOOST`.
 */
export function mergeFindings(passes: readonly (readonly FindingV2[])[]): FindingV2[] {
  const out: { f: FindingV2; pass: number; boosted: boolean }[] = [];
  const rank = { low: 0, medium: 1, high: 2 } as const;
  passes.forEach((list, pass) => {
    for (const f of list) {
      const hit = out.find((o) => o.pass !== pass && sameFinding(o.f, f));
      if (!hit) {
        out.push({ f, pass, boosted: false });
        continue;
      }
      const better = rank[f.severity] > rank[hit.f.severity] || (rank[f.severity] === rank[hit.f.severity] && f.confidence > hit.f.confidence);
      const keep = better ? f : hit.f;
      const evidence = [...hit.f.evidence, ...f.evidence].filter((e, i, all) => all.findIndex((x) => x.file === e.file && x.startLine === e.startLine && x.endLine === e.endLine) === i).slice(0, 5);
      const ruleId = keep.ruleId ?? (better ? hit.f : f).ruleId;
      hit.f = { ...keep, evidence, ...(ruleId ? { ruleId } : {}) };
      if (!hit.boosted) {
        hit.f = { ...hit.f, confidence: Math.min(1, +(hit.f.confidence + BOTH_PASSES_BOOST).toFixed(2)) };
        hit.boosted = true;
      }
    }
  });
  return out.map((o) => o.f);
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
export function mergeRuns(runs: readonly AgentRunResult[]): AgentRunResult {
  const notes = [...new Set(runs.flatMap((r) => (r.notes ? r.notes.split("; ") : [])))].join("; ");
  const ruleChecks = mergeRuleChecks(runs.map((r) => r.ruleChecks));
  return {
    findings: mergeFindings(runs.map((r) => r.findings)),
    notes: notes || undefined,
    usage: addUsage(runs.map((r) => r.usage)),
    incomplete: runs.every((r) => r.incomplete),
    invalidReports: runs.reduce((n, r) => n + r.invalidReports, 0),
    forcedWrapUp: runs.some((r) => r.forcedWrapUp),
    ...(ruleChecks ? { ruleChecks } : {}),
  };
}
