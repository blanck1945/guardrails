import type { LanguageModel } from "ai";
import { MODE_PRESETS, reviewDiff, selectMode, type Finding, type ReviewInput, type ReviewMode, type Rule } from "@/core";
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
import { configSchema } from "@/core/config";
import { CONFIG_PATH } from "./review-rules";
import type { PullRequestEvent, Triggers } from "./webhook";

export const MAX_DIFF_CHARS = 200_000;

/** The PR is bigger than what the MVP reviews in one call. */
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
function fallbackReason(err: unknown): string {
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
function citation(f: Finding, rules: readonly Rule[]): string {
  const c = ruleCitation(f.ruleId, rules);
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
  const rulesNote = rulesChangeNote(files.map((f) => f.filename));

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
  const fullDiff = reviewable.map((f) => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`).join("\n");
  const diff = fullDiff.slice(0, MAX_DIFF_CHARS);

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
      log("review.fallback", { ...at, reason: fallbackReason(err), from: "agent", to: "single" });
    }
  }

  const tracker = new CostTracker({ maxUsd: settings.budgetUsd ?? preset.budgetUsd });
  let result: Awaited<ReturnType<typeof reviewDiff>>;
  try {
    if (mode === "agent") {
      result = await reviewDiff(
        { diff, docs, context: {}, title: pr.data.title, description: pr.data.body ?? "" },
        { config: reviewConfig, model: deps.model, mode: "agent", workspace, costTracker: tracker, abortSignal: signal, reviewMode },
      );
    } else {
      const context: ReviewInput["context"] = {};
      await Promise.all(
        reviewable.slice(0, 15).map(async (f) => {
          const c = await readFile(octo, owner, repo, f.filename, headSha);
          if (c) context[f.filename] = c.slice(0, 30_000);
        }),
      );
      result = await reviewDiff(
        { diff, docs, context, title: pr.data.title, description: pr.data.body ?? "" },
        { config: reviewConfig, model: deps.model, costTracker: tracker, abortSignal: signal, reviewMode },
      );
    }
  } finally {
    // Always: the temp directories hold client code.
    await workspace?.dispose().catch(() => log("review.dispose-failed", at));
  }
  log("review.analyzed", {
    ...at,
    mode,
    reviewMode: selection.mode,
    modeSource: selection.source,
    ms: Date.now() - started,
    costUsd: result.costUsd,
    findings: result.findings.length,
    incomplete: result.incomplete === true,
  });
  // Agent mode may report findings without notes: never post an empty summary.
  const summary =
    result.summary ||
    (result.incomplete
      ? "The analysis of this change could not be completed. Push a new commit to try again."
      : result.findings.length
        ? `Found ${result.findings.length} issue(s) worth a look.`
        : "No issues found.");

  const inline = result.findings.filter((f) => valid.get(f.file)?.has(f.line));
  const orphan = result.findings.filter((f) => !inline.includes(f));

  const body =
    `**Guardrails**\n\n${summary}` +
    (rulesNote ? `\n\n${rulesNote}` : "") +
    (orphan.length
      ? "\n\n" +
        orphan
          .map(
            (f) =>
              `- ${SEVERITY_ICON[f.severity]} \`${f.file}:${f.line}\` **${f.title}** — ${f.body}${citation(f, rules).replace(/\n\n/g, " ")}`,
          )
          .join("\n")
      : "");

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
        `${SEVERITY_ICON[f.severity]} **${f.title}**\n\n${f.body}${citation(f, rules)}` +
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
export const FAILURE_MESSAGES: Record<Exclude<FailureKind, "other">, string> = {
  "diff-too-large": `**Guardrails** skipped this pull request: the change is too large for one review (limit: ${MAX_DIFF_CHARS.toLocaleString("en-US")} characters of diff). Split it into smaller pull requests, or add \`skip-guardrails\` to opt out.`,
  "rate-limit": "**Guardrails** could not review this pull request: a rate limit was hit. Push a new commit to try again.",
  budget: "**Guardrails** stopped this review because it reached its spend limit. Push a new commit to try again.",
  timeout: "**Guardrails** stopped this review because it ran out of time. Push a new commit to try again.",
};

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
    body: FAILURE_MESSAGES[kind],
  });
}
