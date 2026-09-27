import type { LanguageModel } from "ai";
import {
  buildSummary,
  formatCoverageDetails,
  formatCoverageLine,
  formatObservationsBlock,
  messages,
  MODE_PRESETS,
  reviewDiff,
  selectMode,
  splitLowConfidence,
  statsFooter,
  type CoverageFileInput,
  type FallbackReason,
  type Language,
  type Finding,
  type ReviewInput,
  type ReviewMode,
  type Rule,
} from "@/core";
import { fileDiffText, packDiff } from "./diff-pack";
import { commentableLines } from "./diff";
import { DEFAULT_IGNORES, isIgnored } from "@/core/paths";
import {
  asTarballOctokit,
  RepoTooLargeError,
  TarballDownloadError,
  TarballWorkspace,
  type CreateTarballWorkspaceOptions,
  type Workspace,
} from "@/core/workspace";
import { installationOctokit, type Octo } from "./github";
import { log } from "./log";
import { loadReviewRules, ruleCitation, rulesChangeNote, rulesForPr } from "./review-rules";

import { BudgetExceededError, CostTracker } from "@/core/cost";
import { configSchema, safeParseConfig } from "@/core/config";
import { CONFIG_PATH } from "./review-rules";
import type { PullRequestEvent, Triggers } from "./webhook";

export const MAX_DIFF_CHARS = 200_000;

/**
 * Kept for the failure classification and its notice. Since v0.8.0 the cloud no longer throws it: a big PR is packed
 * by whole files (`packDiff`) and the files that do not fit are declared in the coverage.
 */
export class DiffTooLargeError extends Error {
  constructor(
    readonly chars: number,
    readonly max: number,
  ) {
    super(`diff too large: ${chars} characters (limit ${max})`);
    this.name = "DiffTooLargeError";
  }
}
const DOC_PATHS = ["CONTRIBUTING.md", "README.md"];
const SEVERITY_ICON = { low: "🟢", medium: "🟡", high: "🔴" } as const;

export const DEFAULT_REVIEW_BUDGET_USD = 0.25;
export const DEFAULT_REVIEW_TIMEOUT_SEC = 240;

export interface ReviewSettings {
  mode: ReviewMode;
  /** `GUARDRAILS_REVIEW_BUDGET_USD`: when set it replaces the review mode's own budget. */
  budgetUsd: number | undefined;
  /** Deadline for the whole review (default 240; a review mode may ask for less, never more). */
  timeoutSec: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `GUARDRAILS_MODE` (agent|single, default agent), `GUARDRAILS_REVIEW_BUDGET_USD`, `GUARDRAILS_REVIEW_TIMEOUT_SEC`. */
export function reviewSettings(env: Record<string, string | undefined> = process.env): ReviewSettings {
  return {
    mode: env.GUARDRAILS_MODE?.trim().toLowerCase() === "single" ? "single" : "agent",
    budgetUsd: positiveNumber(env.GUARDRAILS_REVIEW_BUDGET_USD, NaN) || undefined,
    timeoutSec: positiveNumber(env.GUARDRAILS_REVIEW_TIMEOUT_SEC, DEFAULT_REVIEW_TIMEOUT_SEC),
  };
}

/** A workspace that owns temporary files and must be disposed. */
export type DisposableWorkspace = Workspace & { dispose(): Promise<void> };

export interface ReviewPrDeps {
  octokit?: (installationId: number) => Promise<Octo>;
  createWorkspace?: (opts: CreateTarballWorkspaceOptions) => Promise<DisposableWorkspace>;
  env?: Record<string, string | undefined>;
  /** Model override (tests). Default: `GUARDRAILS_MODEL`. */
  model?: LanguageModel;
}

/** Why the agent could not start, as a short stable label for logs (never the error message). */
function fallbackReason(err: unknown): FallbackReason {
  if (err instanceof RepoTooLargeError) return "repo-too-large";
  if (err instanceof TarballDownloadError) return err.kind === "timeout" ? "download-timeout" : "download-failed";
  return "workspace-failed";
}

async function readFile(
  octo: Octo,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const res = await octo.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(res.data) || res.data.type !== "file") return null;
    return Buffer.from(res.data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Blank-line-prefixed "Rule `id` (source)" suffix for findings that cite a rule; empty otherwise. */
function citation(f: Finding, rules: readonly Rule[], lang: Language): string {
  const c = ruleCitation(f.ruleId, rules, lang);
  return c ? `\n\n${c}` : "";
}

/**
 * Reviews a PR. Default mode is `agent`: base and head are downloaded as tarballs through the GitHub API into the
 * function's temp disk and the agent reads them (nothing from the repo is executed). If the tarballs cannot be
 * obtained (download error, too large, too slow) it falls back to `single` mode, which reads files through the API.
 */
export async function reviewPullRequest(ev: PullRequestEvent, deps: ReviewPrDeps = {}) {
  const settings = reviewSettings(deps.env);
  const octo = await (deps.octokit ?? installationOctokit)(ev.installationId);
  const createWorkspace = deps.createWorkspace ?? ((o: CreateTarballWorkspaceOptions) => TarballWorkspace.create(o));
  const { owner, repo, number, headSha } = ev;
  const at = { repo: `${owner}/${repo}`, pr: number };
  const started = Date.now();

  const [pr, files] = await Promise.all([
    octo.rest.pulls.get({ owner, repo, pull_number: number }),
    octo.paginate(octo.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
  ]);

  // Config and rules come from the BASE commit so a PR cannot weaken its own review.
  const loaded = await loadReviewRules((p, ref) => readFile(octo, owner, repo, p, ref), pr.data.base.sha);
  const { config } = loaded;
  const lang = config.language;
  if (loaded.configErrors.length) console.warn("guardrails: invalid config, using defaults for affected fields", loaded.configErrors);
  if (loaded.rulesErrors.length) console.warn("guardrails: invalid rules in rules.md (skipped)", loaded.rulesErrors);

  const ignored = [...DEFAULT_IGNORES, ...config.ignorePatterns];
  const reviewable = files.filter(
    (f) => f.patch && f.status !== "removed" && !isIgnored(f.filename, ignored),
  );
  if (!reviewable.length) return;

  // Only active rules whose scope matches a changed file reach the prompt.
  const rules = rulesForPr(loaded, reviewable.map((f) => f.filename));
  const reviewConfig = { ...config, rules };
  const rulesNote = rulesChangeNote(files.map((f) => f.filename), lang);

  // Review mode: PR label / description line (unless `prOverride: none`), then config `autoMode`, config `mode`, `standard`.
  const selection = selectMode({
    labels: (pr.data.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
    description: pr.data.body,
    config,
    stats: { files: reviewable.map((f) => f.filename), linesChanged: reviewable.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0) },
  });
  const preset = MODE_PRESETS[selection.mode];
  const reviewMode = { preset, selection };
  // One deadline for the whole review (tarball download plus the model loop), counted from the start of the handler.
  const deadlineMs = Math.min(settings.timeoutSec, preset.timeoutSec) * 1000;
  const signal = AbortSignal.timeout(Math.max(1, deadlineMs - (Date.now() - started)));

  const valid = new Map(reviewable.map((f) => [f.filename, commentableLines(f.patch)]));
  // The checks and the agent's workspace see the full diff; the model's prompt gets whole files up to the budget (D-028).
  const patchFiles = reviewable.map((f) => ({ filename: f.filename, patch: f.patch! }));
  const fullDiff = patchFiles.map(fileDiffText).join("\n");
  const packed = packDiff(patchFiles, MAX_DIFF_CHARS);
  const diff = packed.diff;
  const overBudget = new Set(packed.overBudget);
  const coverageFiles: CoverageFileInput[] = files.map((f) => {
    if (f.status === "removed") return { path: f.filename, state: "removed" };
    if (isIgnored(f.filename, ignored)) return { path: f.filename, state: "ignored", ignoredBy: isIgnored(f.filename, DEFAULT_IGNORES) ? "default-ignore" : "config-ignore" };
    if (!f.patch) return { path: f.filename, state: "no-diff" };
    return { path: f.filename, state: overBudget.has(f.filename) ? "over-budget" : "in-input" };
  });

  const docs: ReviewInput["docs"] = {};
  const docPaths = [...DOC_PATHS, ...config.files.map((f) => f.path)];
  await Promise.all(
    docPaths.map(async (p) => {
      const c = await readFile(octo, owner, repo, p, headSha);
      if (c) docs[p] = c.slice(0, 20_000);
    }),
  );

  // Agent mode: tarballs of base and head that the agent's tools read.
  let workspace: DisposableWorkspace | undefined;
  let mode: ReviewMode = settings.mode;
  let fallback: FallbackReason | undefined;
  if (mode === "agent") {
    try {
      workspace = await createWorkspace({
        octokit: asTarballOctokit(octo),
        owner,
        repo,
        baseRef: pr.data.base.sha,
        // A fork commit is not addressable by name in the base repo; the PR ref of the base repo always has it.
        headRef: ev.isFork ? `refs/pull/${number}/head` : headSha,
        diff: fullDiff,
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err; // the review-wide timeout is not a reason to start over
      mode = "single";
      fallback = fallbackReason(err);
      log("review.fallback", { ...at, reason: fallback, from: "agent", to: "single" });
    }
  }

  const tracker = new CostTracker({ maxUsd: settings.budgetUsd ?? preset.budgetUsd });
  let result: Awaited<ReturnType<typeof reviewDiff>>;
  // What only this function knows: every changed file with its state, the rules left out of scope and the fallback.
  const coverage = { files: coverageFiles, rulesOutOfScope: loaded.active.length - rules.length, ...(fallback ? { fallback } : {}) };
  try {
    if (mode === "agent") {
      result = await reviewDiff(
        { diff, checksDiff: fullDiff, docs, context: {}, title: pr.data.title, description: pr.data.body ?? "" },
        { config: reviewConfig, model: deps.model, mode: "agent", workspace, costTracker: tracker, abortSignal: signal, reviewMode, coverage },
      );
    } else {
      const context: ReviewInput["context"] = {};
      await Promise.all(
        reviewable.filter((f) => !overBudget.has(f.filename)).slice(0, 15).map(async (f) => {
          const c = await readFile(octo, owner, repo, f.filename, headSha);
          if (c) context[f.filename] = c.slice(0, 30_000);
        }),
      );
      result = await reviewDiff(
        { diff, checksDiff: fullDiff, docs, context, title: pr.data.title, description: pr.data.body ?? "" },
        { config: reviewConfig, model: deps.model, costTracker: tracker, abortSignal: signal, reviewMode, coverage },
      );
    }
  } finally {
    // Always: the temp directories hold client code.
    await workspace?.dispose().catch(() => log("review.dispose-failed", at));
  }
  const ms = Date.now() - started;
  // D-041: in deep, low-confidence model findings without a rule go to the collapsed block, not to inline comments.
  const { published, observations } = splitLowConfidence(result.findings, selection.mode);
  const cov = result.coverage;
  log("review.analyzed", {
    ...at,
    mode,
    reviewMode: selection.mode,
    modeSource: selection.source,
    passes: result.passes,
    passesFailed: result.passesFailed,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    steps: result.usage.steps,
    ms,
    costUsd: result.costUsd,
    findings: result.findings.length,
    merged: result.merged,
    incomplete: result.incomplete === true,
    // Coverage: numbers and codes only (no paths, no code).
    filesChanged: cov.files.total,
    filesReviewed: cov.files.byStatus.reviewed,
    filesIgnored: cov.files.byStatus.ignored,
    filesRemoved: cov.files.byStatus.removed,
    filesNoDiff: cov.files.byStatus["no-diff"],
    filesOverBudget: cov.files.byStatus["over-budget"],
    filesChecksOnly: cov.files.byStatus["checks-only"],
    filesOpened: cov.files.list.filter((f) => f.opened).length + cov.files.contextFilesOpened,
    rulesInScope: cov.rules.inScope,
    rulesByCheck: cov.rules.byCheck,
    rulesByModel: cov.rules.byModel,
    rulesWithVerdict: cov.rules.withVerdict,
    verdictConflicts: cov.rules.verdictConflicts,
    coverageComplete: cov.complete,
    coverageReasons: cov.reasons,
    lowConfidenceObservations: observations.total,
  });
  // The summary is built by code (mode, counts by origin, at most two lines of the model's notes).
  const summary = buildSummary({
    selection,
    total: published.length,
    fromChecks: result.checks.findings,
    fromModel: published.length - result.checks.findings,
    merged: result.merged,
    omitted: result.omitted,
    notes: result.modelSummary,
    incomplete: result.incomplete,
    modelIncomplete: result.modelIncomplete,
    passes: result.passes,
    passesFailed: result.passesFailed,
    // `coverage` comes from the base config: details (default) | line | off.
    coverageLine: config.coverage === "off" ? undefined : formatCoverageLine(cov, lang),
    coverageDetails:
      config.coverage === "details" ? formatCoverageDetails(cov, observations, lang) : observations.total ? formatObservationsBlock(observations, lang) : undefined,
  }, lang);
  const showStats = (deps.env ?? process.env).GUARDRAILS_SHOW_STATS === "1";

  const inline = published.filter((f) => valid.get(f.file)?.has(f.line));
  const orphan = published.filter((f) => !inline.includes(f));

  const body =
    summary +
    (rulesNote ? `\n\n${rulesNote}` : "") +
    (orphan.length
      ? "\n\n" +
        orphan
          .map(
            (f) =>
              `- ${SEVERITY_ICON[f.severity]} \`${f.file}:${f.line}\` **${f.title}** — ${f.body}${citation(f, rules, lang).replace(/\n\n/g, " ")}`,
          )
          .join("\n")
      : "") +
    (showStats ? `\n\n_${statsFooter({ costUsd: result.costUsd, ms, passes: result.passes }, lang)}_` : "");

  await octo.rest.pulls.createReview({
    owner,
    repo,
    pull_number: number,
    commit_id: headSha,
    event: "COMMENT",
    body,
    comments: inline.map((f) => ({
      path: f.file,
      line: f.line,
      side: "RIGHT" as const,
      body:
        `${SEVERITY_ICON[f.severity]} **${f.title}**\n\n${f.body}${citation(f, rules, lang)}` +
        (f.suggestion ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : ""),
    })),
  });
}

/** `config.triggers` from the PR's base commit (defaults when the file is missing or invalid). */
export async function loadTriggersFromBase(ev: PullRequestEvent): Promise<Triggers> {
  const octo = await installationOctokit(ev.installationId);
  const raw = await readFile(octo, ev.owner, ev.repo, CONFIG_PATH, ev.baseSha);
  let triggers: unknown;
  try {
    triggers = raw ? (JSON.parse(raw) as { triggers?: unknown }).triggers : undefined;
  } catch {
    triggers = undefined;
  }
  const parsed = configSchema.shape.triggers.safeParse(triggers);
  return parsed.success ? parsed.data : configSchema.shape.triggers.parse(undefined);
}

export type FailureKind = "diff-too-large" | "rate-limit" | "budget" | "timeout" | "other";

export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof DiffTooLargeError) return "diff-too-large";
  if (err instanceof BudgetExceededError) return "budget";
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  const e = err as { status?: number; statusCode?: number; response?: { headers?: Record<string, string> } } | null;
  const status = e?.status ?? e?.statusCode;
  if (status === 429) return "rate-limit";
  if (status === 403 && e?.response?.headers?.["x-ratelimit-remaining"] === "0") return "rate-limit";
  return "other";
}

/** Fixed, generic wording: never includes error messages, paths, keys or any other internal detail. */
export function failureMessage(kind: Exclude<FailureKind, "other">, lang?: Language): string {
  return messages(lang).cloud.failure[kind](MAX_DIFF_CHARS.toLocaleString("en-US"));
}

/** The English wording (default language). */
export const FAILURE_MESSAGES: Record<Exclude<FailureKind, "other">, string> = {
  "diff-too-large": failureMessage("diff-too-large"),
  "rate-limit": failureMessage("rate-limit"),
  budget: failureMessage("budget"),
  timeout: failureMessage("timeout"),
};

/** `language` from the PR's base commit; English when the file is missing, invalid or cannot be read. */
export async function loadLanguageFromBase(octo: Octo, ev: PullRequestEvent): Promise<Language> {
  try {
    return safeParseConfig(await readFile(octo, ev.owner, ev.repo, CONFIG_PATH, ev.baseSha)).config.language;
  } catch {
    return "en";
  }
}

/** Posts a short notice for known limit failures. Other failures are only logged (no noise on transient errors). */
export async function reportReviewFailure(ev: PullRequestEvent, err: unknown): Promise<void> {
  const kind = classifyFailure(err);
  if (kind === "other") return;
  const octo = await installationOctokit(ev.installationId);
  await octo.rest.pulls.createReview({
    owner: ev.owner,
    repo: ev.repo,
    pull_number: ev.number,
    commit_id: ev.headSha,
    event: "COMMENT",
    body: failureMessage(kind, await loadLanguageFromBase(octo, ev)),
  });
}
