import { promises as fs } from "node:fs";
import path from "node:path";
import { caseSchema, type Case } from "../schema";
import {
  CASES_DIR,
  candidateExclusions,
  commitEdits,
  diffFiles,
  exists,
  fileLanguageGroup,
  git,
  isSource,
  langOfFile,
  listMerged,
  looksLikeFix,
  mirrorPath,
  showFile,
  usedPrNumbers,
  writeCase,
  type MergedCommit,
} from "./mirror";
import { callerRegex, isCode, MUTATIONS, type Mutation } from "./mutations";

/**
 * B12: injected-bug cases. Base = a merged, non-fix PR (squash commit C, parent P). We add one commit on top of C
 * (branch refs/heads/inject/<id> in the mirror) that applies one deterministic mutation to a line the PR added.
 * Case: baseSha = P, headSha = the injected commit, so the reviewed diff is "the PR + the bug".
 */

const MAX_SCAN = 700;
const MAX_SOURCE_FILES = 12;
const MAX_ADDED_LINES = 600;

export interface InjectOptions {
  repo: string; // owner/name
  count: number;
  log?: (msg: string) => void;
}

export interface InjectResult {
  repo: string;
  existing: number;
  created: number;
  crossFile: number;
  byMutation: Record<string, number>;
  scanned: number;
  shortfall: number;
}

const NOISE_FILES = /(^|\/)(index|types?|constants?)\.(ts|js)$|\.d\.ts$|generated|\.min\./i;

interface Applied {
  mutation: Mutation;
  file: string;
  line: number;
  original: string;
  mutated: string;
  content: string;
  detail: string;
  caller?: { file: string; line: number; text: string };
}

async function existingInjected(repoUrl: string): Promise<{ count: number; byMutation: Record<string, number>; cross: number }> {
  const byMutation: Record<string, number> = {};
  let count = 0;
  let cross = 0;
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(CASES_DIR);
  } catch {
    /* none */
  }
  for (const d of dirs) {
    try {
      const c = JSON.parse(await fs.readFile(path.join(CASES_DIR, d, "case.json"), "utf8")) as Case;
      if (c.source !== "injected" || c.repo !== repoUrl) continue;
      count++;
      const id = /^INJECTED \(([\w-]+)\)/.exec(c.bugs[0]?.description ?? "")?.[1];
      if (id) byMutation[id] = (byMutation[id] ?? 0) + 1;
      if (c.bugs[0]?.crossFile) cross++;
    } catch {
      /* ignore unreadable */
    }
  }
  return { count, byMutation, cross };
}

const GREP_GLOBS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.py"];

async function findCaller(
  mirror: string,
  sha: string,
  mutatedFile: string,
  symbol: string,
  use: "call" | "result",
  needsArgs: boolean,
): Promise<{ file: string; line: number; text: string } | null> {
  if (symbol.length < 4) return null;
  let out = "";
  try {
    out = await git(mirror, ["grep", "-n", "-I", "-w", "-F", "-e", symbol, sha, "--", ...GREP_GLOBS]);
  } catch {
    return null;
  }
  const re = callerRegex(symbol, use);
  const withArgs = new RegExp(`\\b${symbol.replace(/[$]/g, "\\$")}\\s*\\([^,)]+,`);
  const base = path.posix.basename(mutatedFile).replace(/\.[^.]+$/, "");
  const modName = base === "index" || base === "__init__" ? path.posix.basename(path.posix.dirname(mutatedFile)) : base;
  const hits: { file: string; line: number; text: string }[] = [];
  for (const l of out.split("\n")) {
    const m = /^[0-9a-f]{40}:(.+?):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    const [, file, line, text] = m as unknown as [string, string, string, string];
    if (file === mutatedFile || !isSource(file) || !isCode(text)) continue;
    if (/^\s*(export|import|from|async\s+def|def|function)\b/.test(text) || !re.test(text)) continue;
    if (needsArgs && !withArgs.test(text)) continue;
    // `x.sym(` is only a call to our symbol when x is the module itself (py `routing.sym(`); otherwise it is some other method.
    const sym = symbol.replace(/[$]/g, "\\$&");
    const member = new RegExp(`([\\w$]+)\\s*\\.\\s*${sym}\\s*\\(`).exec(text);
    const plain = new RegExp(`(^|[^\\w$.])${sym}\\s*\\(`).test(text);
    if (!plain && !(member && member[1] === modName && langOfFile(file) === "py")) continue;
    hits.push({ file, line: Number(line), text });
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const checked = new Map<string, boolean>();
  for (const h of hits.slice(0, 40)) {
    let ok = checked.get(h.file);
    if (ok === undefined) {
      const src = await showFile(mirror, sha, h.file);
      const modRe = new RegExp(`\\b${modName.replace(/[.$]/g, "\\$&")}\\b`);
      ok = src !== null && src.split("\n").some((x) => /\b(import|from|require)\b/.test(x) && modRe.test(x));
      checked.set(h.file, ok);
    }
    if (ok) return h;
  }
  return null;
}

async function tryCommit(mirror: string, c: MergedCommit, wantCross: boolean | null, usage: Record<string, number>): Promise<Applied | null> {
  const files = await diffFiles(mirror, c.parent, c.sha);
  const src = files.filter((f) => isSource(f.file) && f.added > 0 && !NOISE_FILES.test(f.file));
  const allSrc = files.filter((f) => isSource(f.file));
  if (src.length === 0 || allSrc.length > MAX_SOURCE_FILES) return null;
  if (src.reduce((n, f) => n + f.added, 0) > MAX_ADDED_LINES) return null;
  src.sort((a, b) => b.added - a.added || a.file.localeCompare(b.file));

  const pool = MUTATIONS.filter((m) => wantCross === null || m.crossFile === wantCross)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (usage[a.m.id] ?? 0) - (usage[b.m.id] ?? 0) || a.i - b.i)
    .map((x) => x.m);

  const contents = new Map<string, string[]>();
  for (const mut of pool) {
    for (const f of src) {
      const lang = fileLanguageGroup(f.file);
      if (!lang || !mut.languages.includes(lang)) continue;
      let lines = contents.get(f.file);
      if (!lines) {
        const text = await showFile(mirror, c.sha, f.file);
        if (text === null) continue;
        lines = text.split("\n");
        contents.set(f.file, lines);
      }
      for (const ln of f.addedLines) {
        const original = lines[ln - 1];
        if (original === undefined || !isCode(original)) continue;
        const site = mut.apply(original, lang, { lines, index: ln - 1, file: f.file });
        if (!site || site.line === original) continue;
        const next = [...lines];
        next[ln - 1] = site.line;
        const applied: Applied = { mutation: mut, file: f.file, line: ln, original, mutated: site.line, content: next.join("\n"), detail: site.detail };
        if (mut.crossFile) {
          if (!site.symbol) continue;
          const caller = await findCaller(mirror, c.sha, f.file, site.symbol, mut.callerUse ?? "call", mut.id === "signature-params-swapped");
          if (!caller) continue;
          applied.caller = caller;
        }
        return applied;
      }
    }
  }
  return null;
}

export async function mineInject(opts: InjectOptions): Promise<InjectResult> {
  const log = opts.log ?? (() => {});
  const { repo, count } = opts;
  const name = repo.split("/")[1]!;
  const repoUrl = `https://github.com/${repo}`;
  const mirror = mirrorPath(repo);
  if (!(await exists(mirror))) throw new Error(`mirror not found: ${mirror} (run \`pnpm eval mine szz --repo ${repo}\` first to clone it)`);

  const prior = await existingInjected(repoUrl);
  const usage = { ...prior.byMutation };
  const result: InjectResult = { repo, existing: prior.count, created: 0, crossFile: 0, byMutation: {}, scanned: 0, shortfall: 0 };
  const excl = await candidateExclusions(repo);
  const used = await usedPrNumbers(name);
  const merged = (await listMerged(mirror)).filter(
    (c) => !looksLikeFix(c.subject) && !excl.prs.has(c.pr) && !excl.commits.has(c.sha) && !used.clean.has(c.pr) && !used.inj.has(c.pr),
  );
  log(`inject ${repo}: ${merged.length} eligible merged PR commits; ${prior.count} injected cases already exist`);

  let cross = prior.cross;
  let total = prior.count;
  const done = new Set<string>();
  // Pass 1 alternates local/cross-file (every 2nd case cross-file) so cross-file gets >= 40%; pass 2 accepts anything.
  for (const strict of [true, false]) {
    let scanned = 0;
    for (const c of merged) {
      if (total >= count) break;
      if (done.has(c.sha)) continue;
      if (++scanned > MAX_SCAN) break;
      result.scanned++;
      const wantCross = strict ? total % 2 === 1 : null;
      const applied = await tryCommit(mirror, c, wantCross, usage);
      if (!applied) continue;
      done.add(c.sha);

      const id = `${name}-inj-${c.pr}`;
      const ref = `refs/heads/inject/${id}`;
      const m = applied.mutation;
      const headSha = await commitEdits(mirror, c.sha, [{ file: applied.file, content: applied.content }], `inject(${m.id}): ${applied.file}:${applied.line}\n\nBug injected on top of PR #${c.pr}.`, ref);
      const where = `${applied.file}:${applied.line}`;
      const snippet = `\`${applied.original.trim()}\` -> \`${applied.mutated.trim()}\``;
      const bugFile = applied.caller?.file ?? applied.file;
      const bugLine = applied.caller?.line ?? applied.line;
      const bug: Case["bugs"][number] = {
        file: bugFile,
        lines: [bugLine, bugLine],
        description: applied.caller
          ? `INJECTED (${m.id}): ${m.title}. ${applied.detail}. Mutated ${where}: ${snippet}. The bug manifests in ${bugFile}:${bugLine}: \`${applied.caller.text.trim()}\`.`
          : `INJECTED (${m.id}): ${m.title}. ${applied.detail}. Mutated ${where}: ${snippet}.`,
        severity: m.severity,
        category: m.category,
        crossFile: Boolean(applied.caller),
        relatedFiles: applied.caller ? [applied.file] : [],
      };
      const kase: Case = {
        id,
        repo: repoUrl,
        baseSha: c.parent,
        headSha,
        source: "injected",
        language: langOfFile(bugFile) ?? "ts",
        validated: false,
        bugs: [bug],
      };
      caseSchema.parse(kase);
      await writeCase(kase);
      total++;
      result.created++;
      usage[m.id] = (usage[m.id] ?? 0) + 1;
      result.byMutation[m.id] = (result.byMutation[m.id] ?? 0) + 1;
      if (bug.crossFile) {
        cross++;
        result.crossFile++;
      }
      log(`  + ${id} [${m.id}${bug.crossFile ? ", cross-file" : ""}] ${where}${applied.caller ? ` -> ${bugFile}:${bugLine}` : ""}`);
    }
    if (total >= count) break;
  }
  result.shortfall = Math.max(0, count - total);
  return result;
}
