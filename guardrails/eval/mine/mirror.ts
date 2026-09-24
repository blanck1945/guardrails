import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EVAL_DIR } from "../loader";
import type { Case } from "../schema";
import { CACHE_DIR } from "./cache";
import { candidateSchema } from "./candidate";
import { isFixPr, isSourceFile } from "./szz-lib";

/** Offline helpers over the bare mirrors in eval/.cache/mirrors (shared by inject.ts, clean.ts, injection.ts). */

const run = promisify(execFile);

export const MIRRORS_DIR = path.join(CACHE_DIR, "mirrors");
export const CASES_DIR = path.join(EVAL_DIR, "cases");
export const CANDIDATES_DIR = path.join(EVAL_DIR, "candidates");

export type CaseLang = Case["language"];

export function mirrorPath(repo: string): string {
  return path.join(MIRRORS_DIR, `${repo.split("/")[1]!}.git`);
}

export async function git(
  mirror: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const p = run("git", args, {
    cwd: mirror,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
  });
  if (opts.input !== undefined) p.child.stdin?.end(opts.input);
  return (await p).stdout;
}

export async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

export function langOfFile(file: string): CaseLang | null {
  if (file.endsWith(".py")) return "py";
  if (file.endsWith(".tsx")) return "tsx";
  if (/\.(ts|mts|cts)$/.test(file) && !file.endsWith(".d.ts")) return "ts";
  if (/\.(js|jsx|mjs|cjs)$/.test(file)) return "js";
  return null;
}

export function fileLanguageGroup(file: string): "ts" | "py" | null {
  const l = langOfFile(file);
  return l === null ? null : l === "py" ? "py" : "ts";
}

/** Build scripts, CI, tooling: not product code. */
const TOOLING_PATH = /^(build|tools?|bin|\.github|\.husky|config|playground|runtime-tests?)\/|(^|\/)(www|www-old|website|docs_src|docs|sandbox|examples?)(\/|$)/i;

export function isSource(file: string): boolean {
  const g = fileLanguageGroup(file);
  return g !== null && isSourceFile(file, g === "py" ? "py" : "ts") && !TOOLING_PATH.test(file);
}

export interface MergedCommit {
  sha: string;
  parent: string;
  subject: string;
  /** Committer date, unix seconds. */
  time: number;
  pr: number;
}

const PR_SUFFIX = /\(#(\d+)\)\s*$/;
const NOT_A_FEATURE = /^docs\b|^ci\b|^chore\(deps|\bfix(?:es|ed)?\b|🐛|\brevert\b|^bump\b|\(deps|⬆|📝|🌐|👷|🔧|✏/i;

export function looksLikeFix(subject: string): boolean {
  return isFixPr(subject, []) || NOT_A_FEATURE.test(subject);
}

/** First-parent, single-parent squash/rebase merges whose subject ends in "(#N)", newest first. */
export async function listMerged(mirror: string): Promise<MergedCommit[]> {
  const out = await git(mirror, ["log", "--first-parent", "--format=%H%x1f%P%x1f%ct%x1f%s", "HEAD"]);
  const res: MergedCommit[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [sha, parents, time, ...rest] = line.split("\x1f");
    const subject = rest.join("\x1f");
    const m = PR_SUFFIX.exec(subject);
    const ps = (parents ?? "").split(" ").filter(Boolean);
    if (!m || ps.length !== 1) continue;
    res.push({ sha: sha!, parent: ps[0]!, subject, time: Number(time), pr: Number(m[1]) });
  }
  return res;
}

export interface FileDiff {
  file: string;
  added: number;
  deleted: number;
  /** New-side line numbers (1-based) of added lines. */
  addedLines: number[];
}

export async function diffFiles(mirror: string, base: string, head: string): Promise<FileDiff[]> {
  const out = await git(mirror, ["diff", "--unified=0", "--no-renames", "--no-color", base, head]);
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      cur = p === "/dev/null" ? null : { file: p.replace(/^b\//, ""), added: 0, deleted: 0, addedLines: [] };
      if (cur) files.push(cur);
    } else if (line.startsWith("--- ")) {
      cur = null;
    } else if (line.startsWith("@@") && cur) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const n = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < n; i++) cur.addedLines.push(start + i);
      cur.added += n;
    }
  }
  const num = await git(mirror, ["diff", "--numstat", "--no-renames", base, head]);
  const del = new Map<string, number>();
  const add = new Map<string, number>();
  for (const l of num.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
    if (m) {
      add.set(m[3]!, m[1] === "-" ? 0 : Number(m[1]));
      del.set(m[3]!, m[2] === "-" ? 0 : Number(m[2]));
    }
  }
  for (const f of files) f.deleted = del.get(f.file) ?? 0;
  // files with only deletions (or deleted) do not appear in the +++ pass
  for (const [file, d] of del) {
    if (!files.some((f) => f.file === file)) files.push({ file, added: add.get(file) ?? 0, deleted: d, addedLines: [] });
  }
  return files;
}

export async function showFile(mirror: string, sha: string, file: string): Promise<string | null> {
  try {
    return await git(mirror, ["show", `${sha}:${file}`]);
  } catch {
    return null;
  }
}

/** PR numbers and commits already used by SZZ candidates (fix PRs and introducers) for this repo. */
export async function candidateExclusions(repo: string): Promise<{ prs: Set<number>; commits: Set<string> }> {
  const prs = new Set<number>();
  const commits = new Set<string>();
  let files: string[] = [];
  try {
    files = await fs.readdir(CANDIDATES_DIR);
  } catch {
    /* none */
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const parsed = candidateSchema.safeParse(JSON.parse(await fs.readFile(path.join(CANDIDATES_DIR, f), "utf8")));
    if (!parsed.success || parsed.data.repo !== repo) continue;
    const c = parsed.data;
    prs.add(c.fix.number);
    prs.add(c.introducing.pr.number);
    commits.add(c.introducing.commitSha);
    if (c.fix.mergeCommitSha) commits.add(c.fix.mergeCommitSha);
    if (c.introducing.pr.mergeCommitSha) commits.add(c.introducing.pr.mergeCommitSha);
  }
  return { prs, commits };
}

/** PR numbers already used by generated cases ("inj" | "clean") for this repo name. */
export async function usedPrNumbers(name: string): Promise<{ inj: Set<number>; clean: Set<number> }> {
  const inj = new Set<number>();
  const clean = new Set<number>();
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(CASES_DIR);
  } catch {
    /* none */
  }
  for (const d of dirs) {
    const m = new RegExp(`^${name}-(inj|clean)-(\\d+)$`).exec(d);
    if (m) (m[1] === "inj" ? inj : clean).add(Number(m[2]));
  }
  return { inj, clean };
}

export async function writeCase(c: Case): Promise<string> {
  const dir = path.join(CASES_DIR, c.id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "case.json");
  await fs.writeFile(file, JSON.stringify(c, null, 2) + "\n", "utf8");
  return file;
}

/** Creates a commit on top of `parent` with `edits` applied (no checkout), and points `ref` at it. Deterministic. */
export async function commitEdits(
  mirror: string,
  parent: string,
  edits: { file: string; content: string }[],
  message: string,
  ref: string,
): Promise<string> {
  const idx = path.join(CACHE_DIR, `tmp-index-${process.pid}`);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const env = {
    GIT_INDEX_FILE: idx,
    GIT_AUTHOR_NAME: "guardrails-eval",
    GIT_AUTHOR_EMAIL: "eval@guardrails.invalid",
    GIT_COMMITTER_NAME: "guardrails-eval",
    GIT_COMMITTER_EMAIL: "eval@guardrails.invalid",
  };
  try {
    const date = (await git(mirror, ["show", "-s", "--format=%cI", parent])).trim();
    const denv = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    await git(mirror, ["read-tree", parent], { env });
    for (const e of edits) {
      const mode = (await git(mirror, ["ls-tree", parent, "--", e.file])).split(" ")[0] || "100644";
      const blob = (await git(mirror, ["hash-object", "-w", "--stdin"], { input: e.content })).trim();
      await git(mirror, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${e.file}`], { env });
    }
    const tree = (await git(mirror, ["write-tree"], { env })).trim();
    const commit = (await git(mirror, ["commit-tree", tree, "-p", parent, "-m", message], { env: denv })).trim();
    await git(mirror, ["update-ref", ref, commit]);
    return commit;
  } finally {
    await fs.rm(idx, { force: true });
  }
}
