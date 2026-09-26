import type { Coverage, CoverageReason, DropReason, FileCoverage, RuleCoverage } from "./coverage";
import type { ModeName } from "./modes";
import type { Finding } from "./types";

/**
 * Text of the coverage report (A.3): one visible line of at most 220 characters and a collapsed details block of at
 * most 8,000. Pure and deterministic. The words "check" (exact result of code) and "model" (the model's claim) are kept apart.
 */

export const MAX_COVERAGE_LINE = 220;
export const MAX_COVERAGE_DETAILS = 8000;
const MAX_FILE_ROWS = 25;
const MAX_RULE_ROWS = 30;
const MAX_PATH_CHARS = 100;

/** `deep` findings below this confidence and without a rule are not published inline (D-041). */
export const LOW_CONFIDENCE_BELOW = 0.6;
export const MAX_OBSERVATIONS = 5;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const BACKSLASH = String.fromCharCode(92);

/** Paths that look like secrets are never printed. */
const SECRET_LIKE = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*|\.npmrc|\.netrc)$/i;

function shownPath(path: string): string {
  if (SECRET_LIKE.test(path)) return "(hidden: looks like a secret)";
  const p = path.length > MAX_PATH_CHARS ? `…${path.slice(path.length - MAX_PATH_CHARS + 1)}` : path;
  return `\`${p.replaceAll("`", "'").replaceAll("|", `${BACKSLASH}|`)}\``;
}

const MODEL_FAILURE: readonly CoverageReason[] = ["model-timeout", "model-budget", "model-error", "no-valid-report"];

function reasonText(c: Coverage, r: CoverageReason): string {
  switch (r) {
    case "model-timeout":
      return "model ran out of time: checks only";
    case "model-budget":
      return "model reached its spend limit: checks only";
    case "model-error":
      return "model failed: checks only";
    case "no-valid-report":
      return "model gave no valid report: checks only";
    case "pass-failed":
      return `${c.engine.passesFailed} of ${c.engine.passes} passes failed`;
    case "step-budget":
      return "agent hit its step limit";
    case "missing-verdicts": {
      const n = c.rules.list.filter((x) => x.model?.kind === "no-verdict").length;
      return n ? `no verdict for ${plural(n, "rule", "rules")}` : "some rule verdicts missing";
    }
    case "diff-over-budget":
      return `${plural(c.files.byStatus["over-budget"], "file", "files")} over the diff budget`;
    case "single-fallback":
      return `${c.engine.fallback === "repo-too-large" ? "repo too large" : "repo download failed"}: single-call review`;
    case "checks-skipped":
      return `${plural(c.rules.list.filter((x) => x.check?.kind === "not-run").length || 1, "check", "checks")} not run`;
  }
}

/** The visible line: at most 220 characters, whatever the size of the PR or the number of reasons. */
export function formatCoverageLine(c: Coverage): string {
  const modelRan = !c.reasons.some((r) => MODEL_FAILURE.includes(r));
  const shown = c.reasons.slice(0, 2).map((r) => reasonText(c, r));
  const more = c.reasons.length - shown.length;
  const head = c.complete ? "complete" : `partial (${shown.join("; ")}${more > 0 ? `; +${more} more` : ""})`;

  const b = c.files.byStatus;
  const others = [
    b.ignored ? `${b.ignored} ignored` : "",
    b.removed ? `${b.removed} removed` : "",
    b["no-diff"] ? `${b["no-diff"]} without diff` : "",
    b["over-budget"] ? `${b["over-budget"]} over budget` : "",
  ].filter(Boolean);
  const files = c.files.total
    ? `${b.reviewed} of ${plural(c.files.total, "changed file", "changed files")} reviewed${b["checks-only"] ? " by the model" : ""}${others.length ? ` (${others.join(", ")})` : ""}`
    : "no changed files";

  const { inScope, byCheck, byModel, withVerdict } = c.rules;
  const rules = !inScope
    ? "no rules in scope"
    : `${plural(inScope, "rule", "rules")} in scope: ` +
      [byCheck ? `${byCheck} by checks` : "", byModel ? (modelRan ? `${byModel} by the model (${withVerdict} with a verdict)` : `${byModel} not reviewed`) : ""].filter(Boolean).join(", ");

  const line = `Coverage: ${[head, files, rules].join(" · ")}`;
  return line.length <= MAX_COVERAGE_LINE ? line : `${line.slice(0, MAX_COVERAGE_LINE - 1).trimEnd()}…`;
}

function fileStatusText(f: FileCoverage): string {
  switch (f.status) {
    case "removed":
      return "removed";
    case "ignored":
      return `ignored (${f.ignoredBy === "config-ignore" ? "config" : "default"})`;
    case "no-diff":
      return "no diff (binary or too large)";
    case "over-budget":
      return "over the diff budget · checks ran";
    case "checks-only":
      return `checks only${f.opened ? " · opened by the agent" : ""}`;
    case "reviewed":
      return `reviewed${f.opened ? " · opened by the agent" : ""}`;
  }
}

function modelText(m: NonNullable<RuleCoverage["model"]>): string {
  switch (m.kind) {
    case "reported":
      return `${m.count} reported`;
    case "violated-not-published":
      return `violated, not published${m.filtered ? ` (filtered: ${m.filtered})` : ""}`;
    case "ok":
      return "ok";
    case "not-applicable":
      return "not applicable";
    case "not-asked":
      return "not asked";
    case "no-verdict":
      return "no verdict";
    case "not-run":
      return "not run";
  }
}

function checkText(c: NonNullable<RuleCoverage["check"]>): string {
  if (c.kind === "violations") return plural(c.count, "violation", "violations");
  if (c.kind === "none-found") return c.patternOnly ? "none found (pattern only)" : "none found";
  return "not run";
}

function ruleRow(r: RuleCoverage): string {
  const id = `\`${r.id.replaceAll("`", "'").replaceAll("|", `${BACKSLASH}|`)}\``;
  if (r.how === "check") return `| ${id} | check | ${checkText(r.check!)} |`;
  if (r.how === "model") return `| ${id} | model | ${modelText(r.model!)} |`;
  const how = r.how === "check+model" ? "check + model" : "model (check could not run)";
  return `| ${id} | ${how} | check: ${checkText(r.check!)} · model: ${modelText(r.model!)} |`;
}

const DROP_TEXT: Record<DropReason, string> = {
  duplicate: "duplicates (of a check finding or of a finding on the same line)",
  "low-confidence": "below the confidence threshold",
  "comment-type-disabled": "of a disabled comment type",
  "contradicted-by-repo": "contradicted by the repository",
  "over-cap": "over the review cap",
};

export interface Observations {
  /** Findings shown (at most 5), file and title only. */
  shown: { file: string; title: string }[];
  /** Total moved out of the inline comments. */
  total: number;
}

function observationLines(o: Observations): string[] {
  const rows = o.shown.map((f) => `- ${shownPath(f.file)} ${f.title.replace(/\s+/g, " ").trim()}`);
  if (o.total > o.shown.length) rows.push(`- and ${o.total - o.shown.length} more`);
  return ["**Lower-confidence observations** (not posted as comments):", ...rows];
}

/** The collapsed block: at most 8,000 characters (rows are dropped, never cut, until it fits). */
export function formatCoverageDetails(c: Coverage, observations?: Observations): string {
  const build = (fileRows: number, ruleRows: number): string => {
    const files = c.files.list;
    const shownFiles = files.slice(0, fileRows);
    const restReviewed = files.slice(fileRows).length;
    const out: string[] = ["<details><summary>What was reviewed</summary>", ""];
    if (files.length) {
      out.push("| File | Status |", "|---|---|", ...shownFiles.map((f) => `| ${shownPath(f.path)} | ${fileStatusText(f)} |`));
      if (restReviewed) out.push("", `and ${plural(restReviewed, "more file", "more files")}.`);
      out.push("");
    }
    const rules = c.rules.list;
    if (rules.length) {
      out.push("| Rule | How | Result |", "|---|---|---|", ...rules.slice(0, ruleRows).map(ruleRow));
      if (rules.length > ruleRows) out.push("", `and ${plural(rules.length - ruleRows, "more rule", "more rules")}.`);
      out.push("");
    }
    out.push("**check** = exact result of code for what the check tests. **model** = the model's claim; it can be wrong. Coverage says what was looked at, not that it was looked at correctly.");
    const dropped = (Object.keys(DROP_TEXT) as DropReason[]).filter((k) => c.dropped[k]).map((k) => `${c.dropped[k]} ${DROP_TEXT[k]}`);
    const tail = [
      dropped.length ? `Filtered before publishing: ${dropped.join(", ")}.` : "",
      c.engine.mode === "agent" ? `Agent: ${plural(c.engine.steps, "step", "steps")}, ${plural(c.files.contextFilesOpened, "file", "files")} opened outside the diff.` : "Single call: no tools.",
      c.rules.outOfScope ? `${plural(c.rules.outOfScope, "other active rule", "other active rules")} out of scope.` : "",
    ].filter(Boolean);
    out.push(tail.join(" "));
    if (observations && observations.total) out.push("", ...observationLines(observations));
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
export function formatObservationsBlock(o: Observations): string {
  return ["<details><summary>Lower-confidence observations</summary>", "", ...observationLines(o), "</details>"].join("\n");
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
