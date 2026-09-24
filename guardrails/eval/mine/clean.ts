import { caseSchema, type Case } from "../schema";
import {
  CASES_DIR,
  candidateExclusions,
  exists,
  git,
  isSource,
  langOfFile,
  looksLikeFix,
  mirrorPath,
  usedPrNumbers,
  writeCase,
} from "./mirror";
import path from "node:path";

/**
 * B13: clean cases (PLAN-DETAILED 7.1 C). Real merged PRs (squash commits) that:
 *  - are not fix PRs, not SZZ fix/introducing PRs (eval/candidates), not used by an injected case;
 *  - are at least 90 days old in the mirror, and no fix-looking commit touched any of their source files in the
 *    90 days that followed (file-level approximation of "no fix touched their lines");
 *  - are small/medium source changes (1-8 source files, 20-300 changed source lines, >=80% of the change is source,
 *    no lockfiles/manifests).
 * Selection is deterministic: eligible PRs are sampled evenly across the history.
 */

const DAY = 86400;
const WINDOW = 90 * DAY;
const MIN_SOURCE_LINES = 20;
const MAX_SOURCE_LINES = 300;
const MIN_SOURCE_ADDED = 5;
const MAX_SOURCE_FILES = 8;
const MIN_SOURCE_RATIO = 0.8;
const MANIFEST = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|requirements[^/]*\.txt|pyproject\.toml|Pipfile(\.lock)?)$/;

export interface CleanOptions {
  repo: string; // owner/name
  count: number;
  log?: (msg: string) => void;
}

export interface CleanResult {
  repo: string;
  existing: number;
  created: number;
  eligible: number;
  shortfall: number;
}

interface LogCommit {
  sha: string;
  time: number;
  parents: string[];
  subject: string;
  files: { file: string; added: number; deleted: number }[];
}

async function readLog(mirror: string): Promise<LogCommit[]> {
  const out = await git(mirror, ["log", "--first-parent", "--numstat", "--no-renames", "--format=%x1e%H%x1f%ct%x1f%P%x1f%s", "HEAD"]);
  const commits: LogCommit[] = [];
  for (const chunk of out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split("\n");
    const [sha, time, parents, ...subj] = head!.split("\x1f");
    const files: LogCommit["files"] = [];
    for (const l of rest) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
      if (m) files.push({ file: m[3]!, added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
    }
    commits.push({ sha: sha!, time: Number(time), parents: (parents ?? "").split(" ").filter(Boolean), subject: subj.join("\x1f"), files });
  }
  return commits;
}

export async function mineClean(opts: CleanOptions): Promise<CleanResult> {
  const log = opts.log ?? (() => {});
  const { repo, count } = opts;
  const name = repo.split("/")[1]!;
  const repoUrl = `https://github.com/${repo}`;
  const mirror = mirrorPath(repo);
  if (!(await exists(mirror))) throw new Error(`mirror not found: ${mirror} (run \`pnpm eval mine szz --repo ${repo}\` first to clone it)`);

  const commits = await readLog(mirror); // newest first
  const newest = commits[0]?.time ?? 0;
  const excl = await candidateExclusions(repo);
  const used = await usedPrNumbers(name);

  // Fix-looking commits (any first-parent commit, PR-suffixed or not) with the files they touched.
  const fixes = commits.filter((c) => looksLikeFix(c.subject)).map((c) => ({ time: c.time, files: new Set(c.files.map((f) => f.file)) }));

  const eligible: { c: LogCommit; pr: number }[] = [];
  for (const c of commits) {
    const m = /\(#(\d+)\)\s*$/.exec(c.subject);
    if (!m || c.parents.length !== 1) continue;
    const pr = Number(m[1]);
    if (looksLikeFix(c.subject) || excl.prs.has(pr) || excl.commits.has(c.sha) || used.inj.has(pr)) continue;
    if (c.time > newest - WINDOW) continue;
    if (c.files.some((f) => MANIFEST.test(f.file))) continue;
    const src = c.files.filter((f) => isSource(f.file));
    const srcLines = src.reduce((n, f) => n + f.added + f.deleted, 0);
    const allLines = c.files.reduce((n, f) => n + f.added + f.deleted, 0);
    if (src.length < 1 || src.length > MAX_SOURCE_FILES || src.reduce((n, f) => n + f.added, 0) < MIN_SOURCE_ADDED) continue; // skips pure deletions
    if (srcLines < MIN_SOURCE_LINES || srcLines > MAX_SOURCE_LINES || srcLines / allLines < MIN_SOURCE_RATIO) continue;
    const srcNames = new Set(src.map((f) => f.file));
    const refixed = fixes.some((f) => f.time > c.time && f.time <= c.time + WINDOW && [...f.files].some((x) => srcNames.has(x)));
    if (refixed) continue;
    eligible.push({ c, pr });
  }

  const existing = used.clean.size;
  const need = Math.max(0, count - existing);
  log(`clean ${repo}: ${eligible.length} eligible PRs; ${existing} clean cases already exist; generating ${need}`);
  const result: CleanResult = { repo, existing, created: 0, eligible: eligible.length, shortfall: 0 };

  const pool = eligible.filter((e) => !used.clean.has(e.pr));
  const picked: typeof pool = [];
  if (need > 0 && pool.length > 0) {
    const n = Math.min(need, pool.length);
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      let idx = Math.floor(((i + 0.5) * pool.length) / n);
      while (seen.has(idx)) idx = (idx + 1) % pool.length;
      seen.add(idx);
      picked.push(pool[idx]!);
    }
  }
  for (const { c, pr } of picked) {
    const id = `${name}-clean-${pr}`;
    if (await exists(path.join(CASES_DIR, id))) continue;
    const src = c.files.filter((f) => isSource(f.file)).sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
    const kase: Case = {
      id,
      repo: repoUrl,
      baseSha: c.parents[0]!,
      headSha: c.sha,
      source: "clean",
      language: langOfFile(src[0]!.file) ?? "ts",
      validated: false,
      bugs: [],
    };
    caseSchema.parse(kase);
    await writeCase(kase);
    result.created++;
    log(`  + ${id} ${new Date(c.time * 1000).toISOString().slice(0, 10)} ${src.length} src files: ${c.subject.slice(0, 70)}`);
  }
  result.shortfall = Math.max(0, need - result.created);
  return result;
}
