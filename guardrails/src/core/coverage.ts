import type { Rule } from "./config";
import type { RuleChecksMode } from "./agent/prompts";
import type { RuleCheck } from "./findings/schema";
import { selectRulesForFiles } from "./rules/select";
import type { Finding } from "./types";

/**
 * Coverage of a review: what was actually examined, with the mechanical guarantees ("check") and the model's
 * claims ("model") kept apart. Pure computation over data the review already has; it never changes findings.
 * Independent of any provider (D-002) and free of code content (D-030): only paths, rule ids, counters and words.
 */

export const FILE_STATUSES = ["removed", "ignored", "no-diff", "over-budget", "checks-only", "reviewed"] as const;
export type FileCoverageStatus = (typeof FILE_STATUSES)[number];

/** Stable codes (used in logs and records), in display order. */
export const COVERAGE_REASONS = [
  "model-timeout",
  "model-budget",
  "model-error",
  "no-valid-report",
  "pass-failed",
  "step-budget",
  "missing-verdicts",
  "diff-over-budget",
  "single-fallback",
  "checks-skipped",
] as const;
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export type DropReason = "low-confidence" | "comment-type-disabled" | "contradicted-by-repo" | "duplicate" | "over-cap";
export type FallbackReason = "repo-too-large" | "download-timeout" | "download-failed" | "workspace-failed";

/**
 * A changed file as the caller knows it before the review. `in-input` means its patch went into the model input;
 * the other values are decided by the caller (removed by the PR, ignored by patterns, no textual patch, did not fit
 * the model's diff budget). `ignoredBy` tells which kind of pattern ignored the file.
 */
export interface CoverageFileInput {
  path: string;
  state: "removed" | "ignored" | "no-diff" | "over-budget" | "in-input";
  ignoredBy?: "default-ignore" | "config-ignore";
}

/** Data the caller (cloud or CLI) may add on top of what `reviewDiff` knows. */
export interface CoverageContext {
  /** Every changed file with its state. Default: the files of the reviewed diff, all `in-input`. */
  files?: readonly CoverageFileInput[];
  /** Active rules that were left out before the review because their scope matches no reviewable file. */
  rulesOutOfScope?: number;
  /** Set when an agent review fell back to a single call. */
  fallback?: FallbackReason;
}

export interface CoverageInput {
  files: readonly CoverageFileInput[];
  /** Rules given to the review; only `active` ones whose scope matches a reviewable file count as in scope. */
  rules: readonly Rule[];
  rulesOutOfScopeExtra?: number;
  engine: "single" | "agent";
  ruleChecksMode: RuleChecksMode;
  /** Ids of rules whose check ran, of those that ran exhaustively, partially, and the ones that could not run. */
  checks: { ran: readonly string[]; exhaustive: readonly string[]; partial: readonly string[]; skipped: readonly { ruleId: string; reason: string }[] };
  ruleChecks?: readonly RuleCheck[] | undefined;
  /** Published findings (check findings and model findings). */
  findings: readonly Pick<Finding, "ruleId" | "origin">[];
  dropped: readonly { finding: Pick<Finding, "ruleId">; reason: DropReason }[];
  modelIncomplete?: "budget" | "timeout" | "error" | undefined;
  /** Agent mode: the model never produced a valid report. */
  incomplete?: boolean | undefined;
  passes: number;
  passesFailed: number;
  forcedWrapUp: boolean;
  /** Notes of the agent; the marker `incomplete-rule-checks` means a bounced report was accepted without all verdicts. */
  notes?: string | undefined;
  filesOpened: readonly string[];
  steps: number;
  fallback?: FallbackReason | undefined;
}

export type HowCovered = "check" | "check+model" | "check-failed+model" | "model";
export type CheckResult = { kind: "violations"; count: number } | { kind: "none-found"; patternOnly: boolean } | { kind: "not-run" };
export type ModelResult =
  | { kind: "not-run" }
  | { kind: "reported"; count: number }
  | { kind: "violated-not-published"; filtered?: DropReason }
  | { kind: "ok" }
  | { kind: "not-applicable" }
  | { kind: "not-asked" }
  | { kind: "no-verdict" };

export interface RuleCoverage {
  id: string;
  how: HowCovered;
  check?: CheckResult;
  model?: ModelResult;
  /** Headline: `check`, or the model part completed and gave a result other than `not-asked`, `no-verdict`, `not-run`. */
  covered: boolean;
}

export interface FileCoverage {
  path: string;
  status: FileCoverageStatus;
  ignoredBy?: "default-ignore" | "config-ignore";
  /** The agent read this file at the head revision (single mode: it was one of the full-file contexts). */
  opened: boolean;
}

export interface Coverage {
  complete: boolean;
  reasons: CoverageReason[];
  files: {
    total: number;
    byStatus: Record<FileCoverageStatus, number>;
    /** Not reviewed files first, then reviewed ones; each group sorted by path. */
    list: FileCoverage[];
    /** Distinct paths the agent opened that are not changed files of the review. */
    contextFilesOpened: number;
  };
  rules: {
    inScope: number;
    outOfScope: number;
    byCheck: number;
    byModel: number;
    withVerdict: number;
    /** Rules with a model result `ok`/`not-applicable`/... while a published model finding cites the rule (logs only). */
    verdictConflicts: number;
    /** Sorted by id. */
    list: RuleCoverage[];
  };
  engine: { mode: "single" | "agent"; passes: number; passesFailed: number; steps: number; forcedWrapUp: boolean; fallback?: FallbackReason };
  dropped: Partial<Record<DropReason, number>>;
}

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function computeCoverage(input: CoverageInput): Coverage {
  const modelCompleted = !input.modelIncomplete && !input.incomplete;
  const opened = new Set(input.filesOpened);

  // Files: the first matching state wins; `in-input` files split by whether the model part completed.
  const files: FileCoverage[] = input.files.map((f) => {
    const status: FileCoverageStatus = f.state === "in-input" ? (modelCompleted ? "reviewed" : "checks-only") : f.state;
    return { path: f.path, status, ...(f.ignoredBy && status === "ignored" ? { ignoredBy: f.ignoredBy } : {}), opened: opened.has(f.path) };
  });
  files.sort((a, b) => Number(a.status === "reviewed") - Number(b.status === "reviewed") || byPath(a, b));
  const byStatus = Object.fromEntries(FILE_STATUSES.map((s) => [s, 0])) as Record<FileCoverageStatus, number>;
  for (const f of files) byStatus[f.status]++;
  const changed = new Set(input.files.map((f) => f.path));
  const contextFilesOpened = [...opened].filter((p) => !changed.has(p)).length;

  // Rules in scope: active and matching a changed file that is neither removed nor ignored.
  const reviewable = input.files.filter((f) => f.state !== "removed" && f.state !== "ignored").map((f) => f.path);
  const active = input.rules.filter((r) => r.status === "active");
  const inScope = selectRulesForFiles(active, reviewable).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const outOfScope = active.length - inScope.length + (input.rulesOutOfScopeExtra ?? 0);

  const exhaustive = new Set(input.checks.exhaustive);
  const partial = new Set(input.checks.partial);
  const skipped = new Set(input.checks.skipped.map((s) => s.ruleId));
  const askedVerdicts = input.engine === "agent" && input.ruleChecksMode !== "off";
  const modelFindingsByRule = new Map<string, number>();
  const checkFindingsByRule = new Map<string, number>();
  for (const f of input.findings) {
    if (!f.ruleId) continue;
    const m = f.origin === "check" ? checkFindingsByRule : modelFindingsByRule;
    m.set(f.ruleId, (m.get(f.ruleId) ?? 0) + 1);
  }
  const droppedReason = new Map<string, DropReason>();
  for (const d of input.dropped) if (d.finding.ruleId && !droppedReason.has(d.finding.ruleId)) droppedReason.set(d.finding.ruleId, d.reason);

  let verdictConflicts = 0;
  const list: RuleCoverage[] = inScope.map((rule) => {
    const how: HowCovered = exhaustive.has(rule.id) ? "check" : partial.has(rule.id) ? "check+model" : skipped.has(rule.id) ? "check-failed+model" : "model";
    const out: RuleCoverage = { id: rule.id, how, covered: false };
    if (how !== "model") {
      const count = checkFindingsByRule.get(rule.id) ?? 0;
      out.check = how === "check-failed+model" ? { kind: "not-run" } : count ? { kind: "violations", count } : { kind: "none-found", patternOnly: how === "check+model" };
    }
    if (how === "check") {
      out.covered = true;
      return out;
    }
    const verdicts = (input.ruleChecks ?? []).filter((c) => c.ruleId === rule.id);
    const reported = modelFindingsByRule.get(rule.id) ?? 0;
    let model: ModelResult;
    if (!modelCompleted) model = { kind: "not-run" };
    else if (reported) model = { kind: "reported", count: reported };
    else if (verdicts.some((v) => v.verdict === "violated")) {
      const filtered = droppedReason.get(rule.id);
      model = { kind: "violated-not-published", ...(filtered ? { filtered } : {}) };
    } else if (verdicts.some((v) => v.verdict === "ok")) model = { kind: "ok" };
    else if (verdicts.length) model = { kind: "not-applicable" };
    else model = askedVerdicts ? { kind: "no-verdict" } : { kind: "not-asked" };
    if (reported && verdicts.length && !verdicts.some((v) => v.verdict === "violated")) verdictConflicts++;
    out.model = model;
    out.covered = model.kind === "reported" || model.kind === "violated-not-published" || model.kind === "ok" || model.kind === "not-applicable";
    return out;
  });

  const noVerdict = list.filter((r) => r.model?.kind === "no-verdict").length;
  const reasons = new Set<CoverageReason>();
  if (input.modelIncomplete) reasons.add(`model-${input.modelIncomplete}`);
  else if (input.incomplete) reasons.add("no-valid-report");
  if (input.passesFailed > 0) reasons.add("pass-failed");
  if (input.forcedWrapUp) reasons.add("step-budget");
  if (modelCompleted && (input.notes?.includes("incomplete-rule-checks") || noVerdict > 0)) reasons.add("missing-verdicts");
  if (byStatus["over-budget"] > 0) reasons.add("diff-over-budget");
  if (input.fallback) reasons.add("single-fallback");
  if (input.checks.skipped.length) reasons.add("checks-skipped");
  const ordered = COVERAGE_REASONS.filter((r) => reasons.has(r));

  const dropped: Partial<Record<DropReason, number>> = {};
  for (const d of [...input.dropped].sort((a, b) => (a.reason < b.reason ? -1 : 1))) dropped[d.reason] = (dropped[d.reason] ?? 0) + 1;

  return {
    complete: ordered.length === 0,
    reasons: ordered,
    files: { total: files.length, byStatus, list: files, contextFilesOpened },
    rules: {
      inScope: list.length,
      outOfScope,
      byCheck: list.filter((r) => r.how === "check").length,
      byModel: list.filter((r) => r.how !== "check").length,
      withVerdict: list.filter((r) => r.how !== "check" && r.covered).length,
      verdictConflicts,
      list,
    },
    engine: {
      mode: input.engine,
      passes: input.passes,
      passesFailed: input.passesFailed,
      steps: input.steps,
      forcedWrapUp: input.forcedWrapUp,
      ...(input.fallback ? { fallback: input.fallback } : {}),
    },
    dropped,
  };
}
