/**
 * `guardrails review`: reviews the diff between two git revisions of a local repository.
 *
 * Exit codes: 0 = no findings at or above --fail-on, 1 = findings at or above it, 2 = usage or
 * infrastructure error (bad args, no API key, git failure, incomplete review), 3 = budget cut.
 *
 * Config and rules come from the BASE commit (never from the working tree), the same as the cloud
 * webhook, so a change cannot weaken its own review.
 */
import { execFile } from "node:child_process";
import type { LanguageModel } from "ai";
import { parseArgs } from "node:util";
import { defaultConfig, loadRules, type Rule } from "../core";
import { BudgetExceededError, CostTracker } from "../core/cost";
import { defaultModelSpec, MissingApiKeyError } from "../core/models";
import { DEFAULT_IGNORES, isIgnored } from "../core/paths";
import { reviewDiff, type ReviewMode, type ReviewOutput } from "../core/review";
import { selectRulesForFiles } from "../core/rules";
import { estimateRun, planSpend, PROFILES } from "../core/spend";
import type { Finding, ReviewInput } from "../core/types";
import { LocalWorkspace } from "../core/workspace";

export const REVIEW_USAGE =
  "Usage: guardrails review [--path <repo>] [--base <ref>] [--head <ref>] [--mode agent|single] [--model <id>]\n" +
  "                         [--budget-usd <N>] [--dry-run] [--yes] [--json] [--fail-on high|medium|low|none]";

const RULES_PATH = ".guardrails/rules.md";
const CONFIG_PATH = ".guardrails/config.json";
const MAX_DIFF_CHARS = 200_000;
const REVIEW_TIMEOUT_MS = 300_000;
const SEVERITIES = ["low", "medium", "high"] as const;
type Severity = (typeof SEVERITIES)[number];
export type FailOn = Severity | "none";

export interface ReviewCliOptions {
  path: string;
  base?: string | undefined;
  head: string;
  mode: ReviewMode;
  /** Model spec string or a `LanguageModel` instance (tests). Default: `GUARDRAILS_MODEL`. */
  model?: LanguageModel | string | undefined;
  budgetUsd?: number | undefined;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  failOn: FailOn;
  interactive: boolean;
}

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

/** Thrown for problems the user can fix; printed without a stack and mapped to exit code 2. */
class UsageError extends Error {}

export function parseReviewArgs(argv: string[]): ReviewCliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      path: { type: "string", default: "." },
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      mode: { type: "string", default: "agent" },
      model: { type: "string" },
      "budget-usd": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "fail-on": { type: "string", default: "high" },
    },
  });
  if (values.mode !== "agent" && values.mode !== "single") throw new UsageError("--mode must be agent or single");
  const failOn = values["fail-on"] as string;
  if (!["high", "medium", "low", "none"].includes(failOn)) throw new UsageError("--fail-on must be high, medium, low or none");
  const budgetUsd = values["budget-usd"] === undefined ? undefined : Number(values["budget-usd"]);
  if (budgetUsd !== undefined && !(budgetUsd > 0)) throw new UsageError("--budget-usd must be a positive number");
  return {
    path: values.path as string,
    base: values.base,
    head: values.head as string,
    mode: values.mode,
    model: values.model,
    budgetUsd,
    dryRun: values["dry-run"] as boolean,
    yes: values.yes as boolean,
    json: values.json as boolean,
    failOn: failOn as FailOn,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code !== "number") return reject(new UsageError(`git is not available: ${err.message}`));
        resolve({ code: err ? ((err as NodeJS.ErrnoException).code as unknown as number) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function revParse(cwd: string, rev: string): Promise<string | null> {
  if (!rev || rev.startsWith("-")) return null;
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function showAt(cwd: string, rev: string, file: string): Promise<string | null> {
  const r = await git(cwd, ["show", `${rev}:${file}`]);
  return r.code === 0 ? r.stdout : null;
}

/** Candidate default bases, in order: the remote's default branch, then main/master. */
const DEFAULT_BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

export interface ResolvedRange {
  /** Commit the review starts from (merge-base of the requested base and head). */
  baseSha: string;
  headSha: string;
  /** How the base was chosen, for the report. */
  baseLabel: string;
}

export async function resolveRange(root: string, base: string | undefined, head: string): Promise<ResolvedRange> {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) throw new UsageError(`${root} is not a git repository`);
  const headSha = await revParse(root, head);
  if (!headSha) throw new UsageError(`cannot resolve --head "${head}" to a commit`);

  const mergeBase = async (b: string) => {
    const r = await git(root, ["merge-base", b, headSha]);
    return r.code === 0 ? r.stdout.trim() : null;
  };

  if (base) {
    const baseSha = await revParse(root, base);
    if (!baseSha) throw new UsageError(`cannot resolve --base "${base}" to a commit`);
    // PR semantics: compare against the point where the head branched off the base.
    return { baseSha: (await mergeBase(baseSha)) ?? baseSha, headSha, baseLabel: base };
  }
  for (const cand of DEFAULT_BASE_CANDIDATES) {
    const sha = await revParse(root, cand);
    if (!sha) continue;
    const mb = await mergeBase(sha);
    if (mb) return { baseSha: mb, headSha, baseLabel: `merge-base with ${cand}` };
  }
  throw new UsageError(
    `cannot determine a base: none of ${DEFAULT_BASE_CANDIDATES.join(", ")} exists in this repository. Pass --base <ref>.`,
  );
}

/** Keeps only the per-file chunks of a unified diff whose (new) path is not ignored. */
function filterDiff(diff: string, ignores: readonly string[]): { text: string; files: string[] } {
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  const files: string[] = [];
  const kept: string[] = [];
  for (const chunk of chunks) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const file = m?.[2];
    if (!file || isIgnored(file, ignores)) continue;
    if (/^Binary files /m.test(chunk) && !/^@@ /m.test(chunk)) continue;
    if (/^deleted file mode/m.test(chunk)) continue;
    files.push(file);
    kept.push(chunk);
  }
  return { text: kept.join(""), files };
}

const rank = (s: Severity) => SEVERITIES.indexOf(s);

function citation(f: Finding, rules: readonly Rule[]): string | null {
  if (!f.ruleId) return null;
  const r = rules.find((x) => x.id === f.ruleId);
  return r ? `Rule ${r.id}${r.source ? ` (${r.source})` : ""}` : null;
}

function formatHuman(
  out: ReviewOutput,
  rules: readonly Rule[],
  meta: { base: string; head: string; model: string; files: number },
  failOn: FailOn,
): string {
  const lines: string[] = [];
  lines.push(`Guardrails review: ${meta.base.slice(0, 8)}..${meta.head.slice(0, 8)} (${meta.files} file(s)), mode ${out.mode}, model ${meta.model}`);
  if (rules.length) lines.push(`Rules applied: ${rules.map((r) => r.id).join(", ")}`);
  lines.push("");
  const sorted = [...out.findings].sort((a, b) => rank(b.severity) - rank(a.severity));
  if (!sorted.length) lines.push("No findings.");
  for (const f of sorted) {
    lines.push(`${f.file}:${f.line}  [${f.severity}/${f.type}, confidence ${f.confidence}]  ${f.title}`);
    for (const l of f.body.split("\n")) lines.push(`    ${l}`);
    if (f.suggestion) {
      lines.push("    Suggestion:");
      for (const l of f.suggestion.split("\n")) lines.push(`      ${l}`);
    }
    const c = citation(f, rules);
    if (c) lines.push(`    ${c}`);
    lines.push("");
  }
  if (out.dropped.length) {
    lines.push(`Dropped (${out.dropped.length}):`);
    for (const d of out.dropped) lines.push(`  - ${d.reason}: ${d.finding.file}:${d.finding.line} ${d.finding.title} (confidence ${d.finding.confidence}, ${d.finding.type})`);
    lines.push("");
  }
  if (out.notes) lines.push(`Notes: ${out.notes}`);
  lines.push(`Cost: ${out.costUsd === null ? "unknown (no known price)" : `$${out.costUsd.toFixed(5)}`}; ${out.usage.steps} step(s), ${out.usage.inputTokens} input / ${out.usage.outputTokens} output tokens`);
  lines.push(failOn === "none" ? "Threshold: none (never fails)." : `Threshold: fail on ${failOn} or higher.`);
  return lines.join("\n");
}

/** Runs the command and returns the process exit code. Never throws. */
export async function runReview(opts: ReviewCliOptions, io: CliIO): Promise<number> {
  try {
    return await runReviewInner(opts, io);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const s = err.snapshot;
      io.err(`${err.message}. Executed before stopping: ${s.calls} call(s), ${s.totalTokens} tokens, $${s.costUsd.toFixed(4)}${s.complete ? "" : " (+ unpriced tokens)"}. No review was produced.`);
      if (opts.json) io.out(JSON.stringify({ error: "budget-exceeded", costUsd: s.costUsd, calls: s.calls }, null, 2));
      return 3;
    }
    const message = err instanceof MissingApiKeyError || err instanceof UsageError ? err.message : `${err instanceof Error ? err.message : String(err)}`;
    io.err(`guardrails: ${message}`);
    if (opts.json) io.out(JSON.stringify({ error: "failed", message }, null, 2));
    return 2;
  }
}

async function runReviewInner(opts: ReviewCliOptions, io: CliIO): Promise<number> {
  const root = opts.path;
  const range = await resolveRange(root, opts.base, opts.head);
  const { baseSha, headSha } = range;

  // Config and rules from the BASE commit.
  const loaded = loadRules(await showAt(root, baseSha, CONFIG_PATH), await showAt(root, baseSha, RULES_PATH));
  if (loaded.configErrors.length) io.err(`warning: invalid ${CONFIG_PATH} at base, using defaults for affected fields`);
  if (loaded.rulesErrors.length) io.err(`warning: ${loaded.rulesErrors.length} invalid rule(s) in ${RULES_PATH} at base were skipped`);
  const config = loaded.config ?? defaultConfig;

  const workspace = new LocalWorkspace({ root, baseRef: baseSha, headRef: headSha });
  const ignores = [...DEFAULT_IGNORES, ...config.ignorePatterns];
  const { text: diff, files } = filterDiff(await workspace.diff(), ignores);
  if (!files.length) {
    const msg = "No reviewable changes between base and head.";
    io.out(opts.json ? JSON.stringify({ base: baseSha, head: headSha, findings: [], dropped: [], message: msg }, null, 2) : msg);
    return 0;
  }
  if (diff.length > MAX_DIFF_CHARS) {
    throw new UsageError(`diff is too large to review (${diff.length} characters, limit ${MAX_DIFF_CHARS}). Narrow the range with --base/--head.`);
  }

  // Only active rules whose scope matches a changed file reach the model.
  const rules = selectRulesForFiles(loaded.rules, files);
  const reviewConfig = { ...config, rules };
  const modelSpec = opts.model ?? defaultModelSpec();
  const specLabel = typeof modelSpec === "string" ? modelSpec : `${modelSpec.provider}:${modelSpec.modelId}`;

  const plan = planSpend({
    estimate: estimateRun(specLabel, 1, opts.mode === "agent" ? "agent" : "single"),
    budgetUsd: opts.budgetUsd,
    yes: opts.yes,
    dryRun: opts.dryRun,
    interactive: opts.interactive,
  });
  const header = `Range: ${baseSha.slice(0, 8)} (${range.baseLabel}) .. ${headSha.slice(0, 8)}; ${files.length} file(s); ${rules.length} active rule(s) in scope`;
  if (plan.action !== "run") {
    (plan.action === "refuse" ? io.err : io.out)(`${header}\n${plan.message}`);
    return plan.action === "refuse" ? 2 : 0;
  }
  io.err(`${header}\n${plan.message}`);

  const tracker = new CostTracker({ maxUsd: opts.budgetUsd, onWarn: (m) => io.err(`warning: ${m}`) });
  const title = (await git(root, ["log", "-1", "--format=%s", headSha])).stdout.trim();
  const input: ReviewInput = { diff, context: {}, docs: {}, title };
  if (opts.mode === "single") {
    for (const p of ["CONTRIBUTING.md", "README.md", ...config.files.map((f) => f.path)]) {
      const c = await showAt(root, headSha, p);
      if (c) input.docs[p] = c.slice(0, 20_000);
    }
  }
  const out = await reviewDiff(input, {
    config: reviewConfig,
    model: modelSpec,
    mode: opts.mode,
    // Single mode does not use tools, but the workspace still grounds absence claims after the call.
    workspace,
    costTracker: tracker,
    // A hung provider must not hang the terminal (or a git push): give up after 5 minutes.
    abortSignal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
  });

  if (out.incomplete) {
    io.err("guardrails: the model did not produce a valid report (review incomplete).");
  }
  const threshold = opts.failOn === "none" ? Infinity : rank(opts.failOn);
  const blocking = out.findings.filter((f) => rank(f.severity) >= threshold);
  if (opts.json) {
    io.out(JSON.stringify({ base: baseSha, head: headSha, model: specLabel, rules: rules.map((r) => r.id), ...out, blocking: blocking.length }, null, 2));
  } else {
    io.out(formatHuman(out, rules, { base: baseSha, head: headSha, model: specLabel, files: files.length }, opts.failOn));
  }
  if (out.incomplete) return 2;
  // The hook sets GUARDRAILS_FINDINGS_EXIT so it can tell "findings" apart from a crash.
  const findingsExit = Number(process.env.GUARDRAILS_FINDINGS_EXIT) || 1;
  return blocking.length ? findingsExit : 0;
}

export async function reviewMain(argv: string[]): Promise<number> {
  const io: CliIO = { out: (t) => console.log(t), err: (t) => console.error(t) };
  let opts: ReviewCliOptions;
  try {
    opts = parseReviewArgs(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n${REVIEW_USAGE}`);
    return 2;
  }
  return runReview(opts, io);
}
