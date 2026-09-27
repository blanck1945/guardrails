import type { Coverage, CoverageReason, DropReason, FileCoverage, RuleCoverage } from "./coverage";
import { messages, type Language, type Messages } from "./i18n";
import type { ModeName } from "./modes";
import type { Finding } from "./types";

/**
 * Text of the coverage report (A.3): one visible line of at most 220 characters and a collapsed details block of at
 * most 8,000. Pure and deterministic. The words "check" (exact result of code) and "model" (the model's claim) are kept apart.
 * The texts come from `i18n/messages` (English by default, Spanish with `lang: "es"`); the words check and model stay as labels.
 */

export const MAX_COVERAGE_LINE = 220;
export const MAX_COVERAGE_DETAILS = 8000;
const MAX_FILE_ROWS = 25;
const MAX_RULE_ROWS = 30;
const MAX_PATH_CHARS = 100;

/** `deep` findings below this confidence and without a rule are not published inline (D-041). */
export const LOW_CONFIDENCE_BELOW = 0.6;
export const MAX_OBSERVATIONS = 5;

const BACKSLASH = String.fromCharCode(92);

/** Paths that look like secrets are never printed. */
const SECRET_LIKE = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*|\.npmrc|\.netrc)$/i;

function shownPath(path: string, m: Messages): string {
  if (SECRET_LIKE.test(path)) return m.coverage.hiddenPath;
  const p = path.length > MAX_PATH_CHARS ? `…${path.slice(path.length - MAX_PATH_CHARS + 1)}` : path;
  return `\`${p.replaceAll("`", "'").replaceAll("|", `${BACKSLASH}|`)}\``;
}

const MODEL_FAILURE: readonly CoverageReason[] = ["model-timeout", "model-budget", "model-error", "no-valid-report"];

function reasonText(c: Coverage, r: CoverageReason, m: Messages): string {
  const t = m.coverage;
  switch (r) {
    case "model-timeout":
      return t.reasonModelTimeout;
    case "model-budget":
      return t.reasonModelBudget;
    case "model-error":
      return t.reasonModelError;
    case "no-valid-report":
      return t.reasonNoValidReport;
    case "pass-failed":
      return t.reasonPassFailed(c.engine.passesFailed, c.engine.passes);
    case "step-budget":
      return t.reasonStepBudget;
    case "missing-verdicts":
      return t.reasonMissingVerdicts(c.rules.list.filter((x) => x.model?.kind === "no-verdict").length);
    case "diff-over-budget":
      return t.reasonDiffOverBudget(c.files.byStatus["over-budget"]);
    case "single-fallback":
      return t.reasonSingleFallback(c.engine.fallback === "repo-too-large");
    case "checks-skipped":
      return t.reasonChecksSkipped(c.rules.list.filter((x) => x.check?.kind === "not-run").length || 1);
  }
}

/** The visible line: at most 220 characters, whatever the size of the PR or the number of reasons. */
export function formatCoverageLine(c: Coverage, lang?: Language): string {
  const m = messages(lang);
  const t = m.coverage;
  const modelRan = !c.reasons.some((r) => MODEL_FAILURE.includes(r));
  const shown = c.reasons.slice(0, 2).map((r) => reasonText(c, r, m));
  const more = c.reasons.length - shown.length;
  const head = c.complete ? t.complete : t.partial(shown.join("; "), more);

  const b = c.files.byStatus;
  const others = [
    b.ignored ? t.ignored(b.ignored) : "",
    b.removed ? t.removed(b.removed) : "",
    b["no-diff"] ? t.noDiff(b["no-diff"]) : "",
    b["over-budget"] ? t.overBudget(b["over-budget"]) : "",
  ].filter(Boolean);
  const files = c.files.total ? t.filesLine(b.reviewed, c.files.total, b["checks-only"] > 0, others.join(", ")) : t.noChangedFiles;

  const { inScope, byCheck, byModel, withVerdict } = c.rules;
  const rules = !inScope
    ? t.noRulesInScope
    : t.rulesInScope(inScope, [byCheck ? t.byChecks(byCheck) : "", byModel ? (modelRan ? t.byModel(byModel, withVerdict) : t.notReviewed(byModel)) : ""].filter(Boolean).join(", "));

  const line = `${t.prefix}: ${[head, files, rules].join(" · ")}`;
  return line.length <= MAX_COVERAGE_LINE ? line : `${line.slice(0, MAX_COVERAGE_LINE - 1).trimEnd()}…`;
}

function fileStatusText(f: FileCoverage, m: Messages): string {
  const t = m.coverage;
  switch (f.status) {
    case "removed":
      return t.fileRemoved;
    case "ignored":
      return t.fileIgnored(f.ignoredBy === "config-ignore");
    case "no-diff":
      return t.fileNoDiff;
    case "over-budget":
      return t.fileOverBudget;
    case "checks-only":
      return t.fileChecksOnly(!!f.opened);
    case "reviewed":
      return t.fileReviewed(!!f.opened);
  }
}

function modelText(k: NonNullable<RuleCoverage["model"]>, m: Messages): string {
  const t = m.coverage;
  switch (k.kind) {
    case "reported":
      return t.modelReported(k.count);
    case "violated-not-published":
      return t.modelViolatedNotPublished(k.filtered);
    case "ok":
      return t.modelOk;
    case "not-applicable":
      return t.modelNotApplicable;
    case "not-asked":
      return t.modelNotAsked;
    case "no-verdict":
      return t.modelNoVerdict;
    case "not-run":
      return t.modelNotRun;
  }
}

function checkText(c: NonNullable<RuleCoverage["check"]>, m: Messages): string {
  if (c.kind === "violations") return m.coverage.checkViolations(c.count);
  if (c.kind === "none-found") return m.coverage.checkNoneFound(!!c.patternOnly);
  return m.coverage.checkNotRun;
}

function ruleRow(r: RuleCoverage, m: Messages): string {
  const id = `\`${r.id.replaceAll("`", "'").replaceAll("|", `${BACKSLASH}|`)}\``;
  if (r.how === "check") return `| ${id} | check | ${checkText(r.check!, m)} |`;
  if (r.how === "model") return `| ${id} | model | ${modelText(r.model!, m)} |`;
  const how = r.how === "check+model" ? m.coverage.howCheckModel : m.coverage.howModelCheckFailed;
  return `| ${id} | ${how} | check: ${checkText(r.check!, m)} · model: ${modelText(r.model!, m)} |`;
}

const DROP_ORDER: readonly DropReason[] = ["duplicate", "low-confidence", "comment-type-disabled", "contradicted-by-repo", "over-cap"];

function dropText(k: DropReason, m: Messages): string {
  const t = m.coverage;
  switch (k) {
    case "duplicate":
      return t.dropDuplicate;
    case "low-confidence":
      return t.dropLowConfidence;
    case "comment-type-disabled":
      return t.dropCommentTypeDisabled;
    case "contradicted-by-repo":
      return t.dropContradicted;
    case "over-cap":
      return t.dropOverCap;
  }
}

export interface Observations {
  /** Findings shown (at most 5), file and title only. */
  shown: { file: string; title: string }[];
  /** Total moved out of the inline comments. */
  total: number;
}

function observationLines(o: Observations, m: Messages): string[] {
  const rows = o.shown.map((f) => `- ${shownPath(f.file, m)} ${f.title.replace(/\s+/g, " ").trim()}`);
  if (o.total > o.shown.length) rows.push(`- ${m.coverage.observationsMore(o.total - o.shown.length)}`);
  return [m.coverage.observationsTitle, ...rows];
}

/** The collapsed block: at most 8,000 characters (rows are dropped, never cut, until it fits). */
export function formatCoverageDetails(c: Coverage, observations?: Observations, lang?: Language): string {
  const m = messages(lang);
  const t = m.coverage;
  const build = (fileRows: number, ruleRows: number): string => {
    const files = c.files.list;
    const shownFiles = files.slice(0, fileRows);
    const restReviewed = files.slice(fileRows).length;
    const out: string[] = [`<details><summary>${t.detailsSummary}</summary>`, ""];
    if (files.length) {
      out.push(t.fileHeader, "|---|---|", ...shownFiles.map((f) => `| ${shownPath(f.path, m)} | ${fileStatusText(f, m)} |`));
      if (restReviewed) out.push("", t.moreFiles(restReviewed));
      out.push("");
    }
    const rules = c.rules.list;
    if (rules.length) {
      out.push(t.ruleHeader, "|---|---|---|", ...rules.slice(0, ruleRows).map((r) => ruleRow(r, m)));
      if (rules.length > ruleRows) out.push("", t.moreRules(rules.length - ruleRows));
      out.push("");
    }
    out.push(t.legend);
    const dropped = DROP_ORDER.filter((k) => c.dropped[k]).map((k) => `${c.dropped[k]} ${dropText(k, m)}`);
    const tail = [
      dropped.length ? t.filtered(dropped.join(", ")) : "",
      c.engine.mode === "agent" ? t.agentTail(c.engine.steps, c.files.contextFilesOpened) : t.singleTail,
      c.rules.outOfScope ? t.outOfScope(c.rules.outOfScope) : "",
    ].filter(Boolean);
    out.push(tail.join(" "));
    if (observations && observations.total) out.push("", ...observationLines(observations, m));
    out.push("</details>");
    return out.join("\n");
  };
  let fileRows = MAX_FILE_ROWS;
  let ruleRows = MAX_RULE_ROWS;
  let text = build(fileRows, ruleRows);
  while (text.length > MAX_COVERAGE_DETAILS && (fileRows > 1 || ruleRows > 1)) {
    fileRows = Math.max(1, Math.floor(fileRows / 2));
    ruleRows = Math.max(1, Math.floor(ruleRows / 2));
    text = build(fileRows, ruleRows);
  }
  return text;
}

/** The observations alone, collapsed (used when the coverage details are turned off). */
export function formatObservationsBlock(o: Observations, lang?: Language): string {
  const m = messages(lang);
  return [`<details><summary>${m.coverage.observationsSummary}</summary>`, "", ...observationLines(o, m), "</details>"].join("\n");
}

/**
 * D-041: in `deep`, model findings below 0.6 confidence and without a rule are not published as comments; they are
 * listed (file and title, at most 5, most confident first) in the collapsed block. Checks and rule findings never move.
 */
export function splitLowConfidence<T extends Pick<Finding, "confidence" | "ruleId" | "origin" | "file" | "title" | "line">>(
  findings: readonly T[],
  mode: ModeName,
): { published: T[]; observations: Observations } {
  if (mode !== "deep") return { published: [...findings], observations: { shown: [], total: 0 } };
  const isLow = (f: T) => f.origin !== "check" && !f.ruleId && f.confidence < LOW_CONFIDENCE_BELOW;
  const low = findings.filter(isLow).sort((a, b) => b.confidence - a.confidence || (a.file === b.file ? 0 : a.file < b.file ? -1 : 1) || a.line - b.line);
  return {
    published: findings.filter((f) => !isLow(f)),
    observations: { shown: low.slice(0, MAX_OBSERVATIONS).map((f) => ({ file: f.file, title: f.title })), total: low.length },
  };
}
