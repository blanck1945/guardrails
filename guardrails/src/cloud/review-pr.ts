import { safeParseConfig, reviewDiff, type ReviewInput } from "@/core";
import { commentableLines } from "./diff";
import { DEFAULT_IGNORES, isIgnored } from "@/core/paths";
import { installationOctokit } from "./github";

export interface PullRequestEvent {
  installationId: number;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
}

const MAX_DIFF_CHARS = 200_000;
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

/**
 * MVP: reads the PR through the GitHub API (no clone yet).
 * Phase 2 replaces this with a sandbox that clones the repo and runs the agent.
 */
export async function reviewPullRequest(ev: PullRequestEvent) {
  const octo = await installationOctokit(ev.installationId);
  const { owner, repo, number, headSha } = ev;

  const [pr, files, rawConfig] = await Promise.all([
    octo.rest.pulls.get({ owner, repo, pull_number: number }),
    octo.paginate(octo.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 }),
    readFile(octo, owner, repo, ".guardrails/config.json", headSha),
  ]);

  const { config, errors: configErrors } = safeParseConfig(rawConfig);
  if (configErrors.length) console.warn("guardrails: invalid config, using defaults for affected fields", configErrors);
  const ignored = [...DEFAULT_IGNORES, ...config.ignorePatterns];
  const reviewable = files.filter(
    (f) => f.patch && f.status !== "removed" && !isIgnored(f.filename, ignored),
  );
  if (!reviewable.length) return;

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
    { config },
  );

  const inline = result.findings.filter((f) => valid.get(f.file)?.has(f.line));
  const orphan = result.findings.filter((f) => !inline.includes(f));

  const body =
    `**Guardrails**\n\n${result.summary}` +
    (orphan.length
      ? "\n\n" +
        orphan
          .map((f) => `- ${SEVERITY_ICON[f.severity]} \`${f.file}:${f.line}\` **${f.title}** — ${f.body}`)
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
        `${SEVERITY_ICON[f.severity]} **${f.title}**\n\n${f.body}` +
        (f.suggestion ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : ""),
    })),
  });
}
