import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { formatReadResult, truncateLine } from "./format";
import {
  WORKSPACE_LIMITS as L,
  WorkspaceError,
  type GrepInput,
  type GrepResult,
  type ListFilesInput,
  type ListFilesResult,
  type ReadFileInput,
  type ReadFileResult,
  type Reference,
  type ReferencesInput,
  type ReferencesResult,
  type Workspace,
} from "./types";

type GitResult = { code: number; stdout: string };

export type LocalWorkspaceOptions = {
  /** Root of a git checkout. `head` reads come from the head revision, not from the working tree (v0.7.4). */
  root: string;
  /** Revision used for `ref: 'base'` reads and `diff()`. */
  baseRef?: string;
  /** Revision used for `ref: 'head'` reads and as the right side of `diff()`. Default `HEAD`. */
  headRef?: string;
  /**
   * Read the working tree (tracked files, uncommitted edits included) instead of the head revision. Only for
   * `init`, which documents the checkout as it is on disk. Reviews must not use it. Default false.
   */
  workingTree?: boolean;
};

function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    // execFile: args go through argv, never through a shell.
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (typeof e.code === "number") return resolve({ code: e.code, stdout: String(stdout) });
          return reject(new WorkspaceError(`git failed: ${e.killed ? "timeout" : e.message}`));
        }
        resolve({ code: 0, stdout: String(stdout) });
      },
    );
  });
}

/** Normalizes a repo-relative path; throws on absolute paths and `..` escapes. */
export function normalizeRepoPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) throw new WorkspaceError("empty path");
  if (input.includes("\0")) throw new WorkspaceError("invalid path");
  const p = input.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    throw new WorkspaceError(`absolute paths are not allowed: ${input}`);
  }
  const norm = path.posix.normalize(p);
  if (norm === ".." || norm.startsWith("../")) {
    throw new WorkspaceError(`path escapes the repository: ${input}`);
  }
  return norm;
}

function assertSafeRef(ref: string): string {
  if (!ref || ref.startsWith("-") || /[\s\0]/.test(ref)) throw new WorkspaceError(`invalid ref: ${ref}`);
  return ref;
}

/** One record of `git ls-tree -z`: `<mode> <type> <sha>TAB<path>`. */
const TREE_RECORD = /^(\d+) (\w+) [0-9a-f]+\t([\s\S]*)$/;
const SYMLINK_MODE = "120000";

export class LocalWorkspace implements Workspace {
  private readonly root: string;
  private readonly baseRef?: string;
  private readonly headRef: string;
  private readonly workingTree: boolean;
  private realRoot?: string;

  constructor(opts: LocalWorkspaceOptions) {
    this.root = path.resolve(opts.root);
    this.baseRef = opts.baseRef ? assertSafeRef(opts.baseRef) : undefined;
    this.headRef = assertSafeRef(opts.headRef ?? "HEAD");
    this.workingTree = opts.workingTree === true;
  }

  private async getRealRoot(): Promise<string> {
    return (this.realRoot ??= await fs.realpath(this.root));
  }

  /** Working-tree mode only: resolves a repo-relative path to a real file inside the repo (follows symlinks, then checks). */
  private async resolveInside(rel: string): Promise<string> {
    const norm = normalizeRepoPath(rel);
    const realRoot = await this.getRealRoot();
    let real: string;
    try {
      real = await fs.realpath(path.join(realRoot, norm));
    } catch {
      throw new WorkspaceError(`file not found: ${rel}`);
    }
    const relToRoot = path.relative(realRoot, real);
    if (relToRoot === ".." || relToRoot.startsWith(".." + path.sep) || path.isAbsolute(relToRoot)) {
      throw new WorkspaceError(`path resolves outside the repository: ${rel}`);
    }
    return real;
  }

  /** Tree entry of `rev:path`, or null when it does not exist. */
  private async treeEntry(rev: string, norm: string): Promise<{ mode: string; type: string; path: string } | null> {
    const r = await git(this.root, ["ls-tree", "-z", rev, "--", norm]);
    if (r.code !== 0) throw new WorkspaceError(`invalid revision: ${rev}`);
    const rec = r.stdout.split("\0").find(Boolean);
    const m = rec ? TREE_RECORD.exec(rec) : null;
    return m ? { mode: m[1]!, type: m[2]!, path: m[3]! } : null;
  }

  /** Paths of the head tree that are symlinks. They are never followed, listed or searched. */
  private async headSymlinks(): Promise<Set<string>> {
    const r = await git(this.root, ["ls-tree", "-r", "-z", this.headRef]);
    if (r.code !== 0) throw new WorkspaceError(`git ls-tree failed for ${this.headRef}`);
    const out = new Set<string>();
    for (const rec of r.stdout.split("\0")) {
      const m = TREE_RECORD.exec(rec);
      if (m && m[1] === SYMLINK_MODE) out.add(m[3]!);
    }
    return out;
  }

  async readFile(input: ReadFileInput): Promise<ReadFileResult> {
    const ref = input.ref ?? "head";
    const norm = normalizeRepoPath(input.path);
    let text: string;
    if (ref === "base") {
      if (!this.baseRef) throw new WorkspaceError("no baseRef configured");
      const r = await git(this.root, ["show", `${this.baseRef}:${norm}`]);
      if (r.code !== 0) throw new WorkspaceError(`file not found in base: ${input.path}`);
      text = r.stdout;
    } else if (this.workingTree) {
      const real = await this.resolveInside(norm);
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw new WorkspaceError(`not a file: ${input.path}`);
      text = await fs.readFile(real, "utf8");
    } else {
      // The head revision, never the working tree: the result does not depend on the checked-out branch.
      const entry = await this.treeEntry(this.headRef, norm);
      if (!entry) throw new WorkspaceError(`file not found: ${input.path}`);
      if (entry.mode === SYMLINK_MODE) throw new WorkspaceError(`path resolves outside the repository (symlink): ${input.path}`);
      if (entry.type !== "blob" || entry.path !== norm) throw new WorkspaceError(`not a file: ${input.path}`);
      const r = await git(this.root, ["show", `${this.headRef}:${norm}`]);
      if (r.code !== 0) throw new WorkspaceError(`file not found: ${input.path}`);
      text = r.stdout;
    }
    return formatReadResult(text, norm, ref, input);
  }

  private globSpec(glob: string): string {
    return `:(glob)${normalizeRepoPath(glob)}`;
  }

  /** Searches the head revision (`git grep <headRef>`); the `<headRef>:` prefix git adds is stripped. */
  private async gitGrep(flags: string[], pattern: string, pathspec: string | undefined, max: number) {
    const args = ["grep", "-n", "-I", "--no-color", ...flags, "-e", pattern, ...(this.workingTree ? [] : [this.headRef]), "--"];
    if (pathspec) args.push(pathspec);
    const r = await git(this.root, args, L.grepTimeoutMs);
    if (r.code > 1) throw new WorkspaceError("git grep failed (invalid pattern or head revision)");
    if (this.workingTree) {
      const own = r.stdout.split("\n").filter((l) => l.length > 0);
      return { lines: own.slice(0, max), truncated: own.length > max };
    }
    const prefix = `${this.headRef}:`;
    let lines = r.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
    if (lines.length) {
      const links = await this.headSymlinks();
      if (links.size) lines = lines.filter((l) => !links.has(/^(.*?):\d+:/.exec(l)?.[1] ?? ""));
    }
    return { lines: lines.slice(0, max), truncated: lines.length > max };
  }

  async grep(input: GrepInput): Promise<GrepResult> {
    if (!input.pattern) throw new WorkspaceError("empty pattern");
    const flags = [input.fixed ? "-F" : "-E"];
    if (input.ignoreCase) flags.push("-i");
    const spec = input.pathGlob ? this.globSpec(input.pathGlob) : undefined;
    const { lines, truncated } = await this.gitGrep(flags, input.pattern, spec, L.grepMaxMatches);
    return { matches: lines.map(truncateLine), truncated };
  }

  async listFiles(input: ListFilesInput = {}): Promise<ListFilesResult> {
    if (this.workingTree && input.ref !== "base") {
      const w = await git(this.root, ["ls-files", "-z"]);
      if (w.code !== 0) throw new WorkspaceError("git ls-files failed");
      let own = w.stdout.split("\0").filter(Boolean);
      if (input.glob) {
        const isMatch = picomatch(normalizeRepoPath(input.glob), { dot: true });
        own = own.filter((f) => isMatch(f));
      }
      own.sort();
      const lim = Math.min(Math.max(1, Math.floor(input.limit ?? L.listMaxFiles)), 50_000);
      return { files: own.slice(0, lim), truncated: own.length > lim };
    }
    let rev = this.headRef;
    if (input.ref === "base") {
      if (!this.baseRef) throw new WorkspaceError("no baseRef configured");
      rev = this.baseRef;
    }
    const r = await git(this.root, ["ls-tree", "-r", "-z", rev]);
    if (r.code !== 0) throw new WorkspaceError(`git ls-tree failed for ${rev}`);
    let files: string[] = [];
    for (const rec of r.stdout.split("\0")) {
      const m = TREE_RECORD.exec(rec);
      // Symlinks of the head tree are skipped, as in the tarball workspace.
      if (m && !(rev === this.headRef && m[1] === SYMLINK_MODE)) files.push(m[3]!);
    }
    if (input.glob) {
      const isMatch = picomatch(normalizeRepoPath(input.glob), { dot: true });
      files = files.filter((f) => isMatch(f));
    }
    files.sort();
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? L.listMaxFiles)), 50_000);
    return { files: files.slice(0, limit), truncated: files.length > limit };
  }

  async diff(): Promise<string> {
    if (!this.baseRef) throw new WorkspaceError("no baseRef configured");
    const r = await git(this.root, ["diff", "--no-color", "--no-ext-diff", this.baseRef, this.headRef, "--"]);
    if (r.code !== 0) throw new WorkspaceError("git diff failed");
    return r.stdout;
  }

  async findReferencesByName(input: ReferencesInput): Promise<ReferencesResult> {
    const symbol = input.symbol?.trim();
    if (!symbol || symbol.length > 200) throw new WorkspaceError("invalid symbol");
    const spec = input.path ? this.globSpec(input.path) : undefined;
    const { lines, truncated } = await this.gitGrep(["-w", "-F"], symbol, spec, L.referencesMaxMatches);
    const references: Reference[] = [];
    for (const l of lines) {
      const m = /^(.*?):(\d+):(.*)$/.exec(l);
      if (!m) continue;
      references.push({
        path: m[1]!,
        line: Number(m[2]),
        kind: "reference",
        confidence: "name",
        text: truncateLine(m[3]!.trim()),
      });
    }
    return { references, truncated };
  }
}
