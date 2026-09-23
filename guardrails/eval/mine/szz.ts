import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EVAL_DIR, loadRepos } from "../loader";
import type { Candidate } from "./candidate";
import { candidateSchema } from "./candidate";
import { CACHE_DIR, createCache } from "./cache";
import { createOctokit, type Api } from "./github";
import {
  isFixPr,
  isMeaningfulLine,
  isSourceFile,
  parseBlamePorcelain,
  parseRemovedRanges,
  pickIntroducingCommit,
  toRanges,
  type BlamedLine,
} from "./szz-lib";

const run = promisify(execFile);

export const CANDIDATES_DIR = path.join(EVAL_DIR, "candidates");
const MIRRORS_DIR = path.join(CACHE_DIR, "mirrors");
const LIST_TTL_MS = 6 * 3600_000;

/** Skip fixes that touch too much to give a clean SZZ signal. */
const MAX_FIX_SOURCE_FILES = 8;
const MAX_BLAMED_LINES = 80;
const MAX_INTRO_PR_FILES = 50;

export interface MineOptions {
  repo: string; // owner/name
  limit: number;
  maxPages?: number;
  log?: (msg: string) => void;
}

export interface MineResult {
  repo: string;
  /** Candidates on disk for this repo after the run (new + pre-existing). */
  total: number;
  created: number;
  scannedFixPrs: number;
  skipped: Record<string, number>;
  apiCache: { hits: number; misses: number };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/** Bare, full-history mirror under eval/.cache/mirrors (public repos need no credentials). */
export async function ensureMirror(repo: string, log: (m: string) => void): Promise<string> {
  const name = repo.split("/")[1]!;
  const dir = path.join(MIRRORS_DIR, `${name}.git`);
  await fs.mkdir(MIRRORS_DIR, { recursive: true });
  if (await exists(dir)) {
    log(`mirror: fetching updates for ${name}`);
    await git(dir, ["fetch", "--quiet", "origin", "+refs/heads/*:refs/heads/*"]);
  } else {
    log(`mirror: cloning ${repo} (bare, full history)`);
    await git(MIRRORS_DIR, ["clone", "--bare", "--quiet", `https://github.com/${repo}.git`, dir]);
  }
  return dir;
}

type ListedPr = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  mergedAt: string | null;
  mergeCommitSha: string | null;
  baseRef: string;
  baseSha: string;
  headSha: string;
};

async function listPage(api: Api, cache: ReturnType<typeof createCache>, repo: string, page: number): Promise<ListedPr[]> {
  const [owner, name] = repo.split("/") as [string, string];
  return cache.get(`pulls.list:${repo}:closed:${page}`, LIST_TTL_MS, async () => {
    const res = await api.rest.pulls.list({
      owner,
      repo: name,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page,
    });
    return res.data.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url,
      labels: p.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
      mergedAt: p.merged_at,
      mergeCommitSha: p.merge_commit_sha,
      baseRef: p.base.ref,
      baseSha: p.base.sha,
      headSha: p.head.sha,
    }));
  });
}

type IntroPr = {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  mergeCommitSha: string | null;
  baseSha: string;
  headSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
};

/** Merged PR that introduced `commit` (immutable, cached forever). */
async function findIntroPr(
  api: Api,
  cache: ReturnType<typeof createCache>,
  repo: string,
  defaultBranch: string,
  commit: string,
): Promise<IntroPr | null> {
  const [owner, name] = repo.split("/") as [string, string];
  const candidates = await cache.get(`commit.pulls:${repo}:${commit}`, null, async () => {
    const res = await api.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo: name, commit_sha: commit });
    return res.data.map((p) => ({
      number: p.number,
      mergedAt: p.merged_at,
      mergeCommitSha: p.merge_commit_sha,
      baseRef: p.base.ref,
    }));
  });
  const merged = candidates.filter((p) => p.mergedAt && p.baseRef === defaultBranch);
  const pick = merged.find((p) => p.mergeCommitSha === commit) ?? merged[0];
  if (!pick) return null;
  return cache.get(`pulls.get:${repo}:${pick.number}`, null, async () => {
    const { data: p } = await api.rest.pulls.get({ owner, repo: name, pull_number: pick.number });
    return {
      number: p.number,
      title: p.title,
      url: p.html_url,
      mergedAt: p.merged_at!,
      mergeCommitSha: p.merge_commit_sha,
      baseSha: p.base.sha,
      headSha: p.head.sha,
      changedFiles: p.changed_files,
      additions: p.additions,
      deletions: p.deletions,
    };
  });
}

function languageOf(files: string[]): Candidate["language"] {
  const first = files[0] ?? "";
  if (first.endsWith(".py")) return "py";
  if (first.endsWith(".tsx")) return "tsx";
  if (/\.(js|jsx|mjs|cjs)$/.test(first)) return "js";
  return "ts";
}

type Skip = string;

/** SZZ for one fix PR. Returns a candidate or the reason it was skipped. */
async function szzForFix(
  ctx: { api: Api; cache: ReturnType<typeof createCache>; repo: string; mirror: string; defaultBranch: string; lang: "ts" | "py" },
  fix: ListedPr,
): Promise<Candidate | Skip> {
  const { mirror, repo } = ctx;
  const mergeSha = fix.mergeCommitSha;
  if (!mergeSha) return "no merge commit";
  try {
    await git(mirror, ["cat-file", "-e", `${mergeSha}^{commit}`]);
  } catch {
    return "merge commit not in mirror";
  }
  const parents = (await git(mirror, ["rev-list", "--parents", "-n", "1", mergeSha])).trim().split(" ");
  const parentSha = parents[1];
  if (!parentSha) return "root commit";

  const diff = await git(mirror, ["diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=M", parentSha, mergeSha]);
  const removed = parseRemovedRanges(diff);
  const files = [...removed.keys()].filter((f) => isSourceFile(f, ctx.lang));
  if (files.length === 0) return "no modified source lines";
  if (files.length > MAX_FIX_SOURCE_FILES) return "fix touches too many files";

  const fixTime = Number((await git(mirror, ["log", "-1", "--format=%ct", mergeSha])).trim());
  const blamed: (BlamedLine & { fixFile: string })[] = [];
  for (const file of files) {
    const args = ["blame", "--line-porcelain", "-w"];
    for (const [s, e] of removed.get(file)!) args.push("-L", `${s},${e}`);
    args.push(parentSha, "--", file);
    let out: string;
    try {
      out = await git(mirror, args);
    } catch {
      continue; // range past EOF, binary, etc.
    }
    for (const l of parseBlamePorcelain(out)) {
      if (l.boundary || !isMeaningfulLine(l.content) || l.committerTime >= fixTime) continue;
      blamed.push({ ...l, fixFile: file });
    }
  }
  if (blamed.length === 0) return "no blameable lines";
  if (blamed.length > MAX_BLAMED_LINES) return "too many blamed lines";

  const top = pickIntroducingCommit(blamed);
  if (!top) return "no introducing commit";
  const introPr = await findIntroPr(ctx.api, ctx.cache, repo, ctx.defaultBranch, top.commit);
  if (!introPr) return "introducing commit has no merged PR";
  if (introPr.number === fix.number) return "introducing PR is the fix PR";
  if (introPr.changedFiles > MAX_INTRO_PR_FILES) return "introducing PR too large";

  const daysToFix = (Date.parse(fix.mergedAt!) - Date.parse(introPr.mergedAt)) / 86_400_000;
  if (!(daysToFix >= 0)) return "fix merged before introducing PR";

  const mine = blamed.filter((l) => l.commit === top.commit);
  const groups = new Map<string, { file: string; fixFile: string; lines: number[] }>();
  for (const l of mine) {
    const key = `${l.fixFile}\0${l.filename}`;
    const g = groups.get(key) ?? { file: l.filename, fixFile: l.fixFile, lines: [] };
    g.lines.push(l.origLine);
    groups.set(key, g);
  }

  const short = repo.split("/")[1]!;
  const candidate: Candidate = {
    schemaVersion: 1,
    id: `${short}-${fix.number}`,
    repo,
    language: languageOf([...groups.values()].map((g) => g.file)),
    minedAt: new Date().toISOString(),
    fix: {
      number: fix.number,
      title: fix.title,
      url: fix.url,
      mergedAt: fix.mergedAt!,
      mergeCommitSha: mergeSha,
      baseSha: fix.baseSha,
      headSha: fix.headSha,
      labels: fix.labels,
      parentSha,
    },
    introducing: {
      commitSha: top.commit,
      commitDate: new Date(top.committerTime * 1000).toISOString(),
      pr: {
        number: introPr.number,
        title: introPr.title,
        url: introPr.url,
        mergedAt: introPr.mergedAt,
        mergeCommitSha: introPr.mergeCommitSha,
        baseSha: introPr.baseSha,
        headSha: introPr.headSha,
        changedFiles: introPr.changedFiles,
        additions: introPr.additions,
        deletions: introPr.deletions,
      },
    },
    bugLines: [...groups.values()].map((g) => ({
      file: g.file,
      ranges: toRanges(g.lines),
      fixFile: g.fixFile,
      fixRanges: removed.get(g.fixFile)!,
    })),
    blamedLines: mine.length,
    daysToFix: Math.round(daysToFix * 10) / 10,
  };
  return candidateSchema.parse(candidate);
}

/** Mines up to `limit` SZZ candidates for `repo` and writes eval/candidates/<id>.json. */
export async function mineSzz(opts: MineOptions): Promise<MineResult> {
  const log = opts.log ?? (() => {});
  const { repos, issues } = await loadRepos();
  const entry = repos?.repos.find((r) => r.repo === opts.repo);
  if (!entry) {
    throw new Error(`${opts.repo} is not in eval/repos.json${issues.length ? " (repos.json has validation issues)" : ""}`);
  }
  const lang = entry.language === "py" ? "py" : "ts";
  const [owner, name] = opts.repo.split("/") as [string, string];

  const api = await createOctokit();
  const cache = createCache();
  const mirror = await ensureMirror(opts.repo, log);
  const defaultBranch = (await git(mirror, ["symbolic-ref", "--short", "HEAD"])).trim();
  await fs.mkdir(CANDIDATES_DIR, { recursive: true });

  const existing = (await fs.readdir(CANDIDATES_DIR)).filter((f) => f.startsWith(`${name}-`) && f.endsWith(".json"));
  const have = new Set(existing.map((f) => f.slice(0, -5)));
  const result: MineResult = {
    repo: opts.repo,
    total: have.size,
    created: 0,
    scannedFixPrs: 0,
    skipped: {},
    apiCache: cache.stats,
  };
  const ctx = { api, cache, repo: opts.repo, mirror, defaultBranch, lang } as const;

  const maxPages = opts.maxPages ?? 30;
  for (let page = 1; page <= maxPages && result.total < opts.limit; page++) {
    const prs = await listPage(api, cache, opts.repo, page);
    if (prs.length === 0) break;
    for (const pr of prs) {
      if (result.total >= opts.limit) break;
      if (!pr.mergedAt || pr.baseRef !== defaultBranch) continue;
      if (!isFixPr(pr.title, pr.labels, entry.bugLabel)) continue;
      const id = `${name}-${pr.number}`;
      if (have.has(id)) continue;
      result.scannedFixPrs++;
      let out: Candidate | Skip;
      try {
        out = await szzForFix(ctx, pr);
      } catch (e) {
        out = `error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
      }
      if (typeof out === "string") {
        result.skipped[out] = (result.skipped[out] ?? 0) + 1;
        continue;
      }
      await fs.writeFile(path.join(CANDIDATES_DIR, `${id}.json`), JSON.stringify(out, null, 2) + "\n");
      have.add(id);
      result.total++;
      result.created++;
      log(`  ${id}: fix #${out.fix.number} <- introduced by #${out.introducing.pr.number} (${out.blamedLines} lines, ${out.daysToFix}d)`);
    }
    log(`page ${page} done: ${result.total}/${opts.limit} candidates`);
  }
  void owner;
  return result;
}
