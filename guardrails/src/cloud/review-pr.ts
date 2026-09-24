import { reviewDiff, type Finding, type ReviewInput, type Rule } from "@/core";
import { commentableLines } from "./diff";
import { DEFAULT_IGNORES, isIgnored } from "@/core/paths";
import { installationOctokit } from "./github";
import { loadReviewRules, ruleCitation, rulesChangeNote, rulesForPr } from "./review-rules";

import { BudgetExceededError } from "@/core/cost";
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

async function readFile(
  octo: Awaited<ReturnType<typeof installationOctokit>>,
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
 * MVP: reads the PR through the GitHub API (no clone yet).
 * Phase 2 replaces this with a sandbox that clones the repo and runs the agent.
 */
export async function reviewPullRequest(ev: PullRequestEvent) {
  const octo = await installationOctokit(ev.installationId);
  const { owner, repo, number, headSha } = ev;

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

  const valid = new Map(reviewable.map((f) => [f.filename, commentableLines(f.patch)]));
  const diff = reviewable
    .map((f) => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`)
    .join("\n")
    .slice(0, MAX_DIFF_CHARS);

  const docs: ReviewInput["docs"] = {};
  const docPaths = [...DOC_PATHS, ...config.files.map((f) => f.path)];
  await Promise.all(
    docPaths.map(async (p) => {
      const c = await readFile(octo, owner, repo, p, headSha);
      if (c) docs[p] = c.slice(0, 20_000);
    }),
  );

  const context: ReviewInput["context"] = {};
  await Promise.all(
    reviewable.slice(0, 15).map(async (f) => {
      const c = await readFile(octo, owner, repo, f.filename, headSha);
      if (c) context[f.filename] = c.slice(0, 30_000);
    }),
  );

  const result = await reviewDiff(
    { diff, docs, context, title: pr.data.title, description: pr.data.body ?? "" },
    { config: reviewConfig },
  );

  const inline = result.findings.filter((f) => valid.get(f.file)?.has(f.line));
  const orphan = result.findings.filter((f) => !inline.includes(f));

  const body =
    `**Guardrails**\n\n${result.summary}` +
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

export type FailureKind = "diff-too-large" | "rate-limit" | "budget" | "other";

export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof DiffTooLargeError) return "diff-too-large";
  if (err instanceof BudgetExceededError) return "budget";
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
