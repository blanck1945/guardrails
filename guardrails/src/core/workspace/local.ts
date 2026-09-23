import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
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
  /** Root of a git checkout. `head` reads come from its working tree. */
  root: string;
  /** Revision used for `ref: 'base'` reads and `diff()`. */
  baseRef?: string;
  /** Revision used as the right side of `diff()`. Default `HEAD`. */
  headRef?: string;
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

function truncateLine(s: string): string {
  return s.length > L.grepMaxLineChars ? s.slice(0, L.grepMaxLineChars) + "..." : s;
}

export class LocalWorkspace implements Workspace {
  private readonly root: string;
  private readonly baseRef?: string;
  private readonly headRef: string;
  private realRoot?: string;

  constructor(opts: LocalWorkspaceOptions) {
    this.root = path.resolve(opts.root);
    this.baseRef = opts.baseRef ? assertSafeRef(opts.baseRef) : undefined;
    this.headRef = assertSafeRef(opts.headRef ?? "HEAD");
  }

  private async getRealRoot(): Promise<string> {
    return (this.realRoot ??= await fs.realpath(this.root));
  }

  /** Resolves a repo-relative path to a real file path inside the repo (follows symlinks, then checks). */
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

  async readFile(input: ReadFileInput): Promise<ReadFileResult> {
    const ref = input.ref ?? "head";
    const norm = normalizeRepoPath(input.path);
    let text: string;
    if (ref === "base") {
      if (!this.baseRef) throw new WorkspaceError("no baseRef configured");
      const r = await git(this.root, ["show", `${this.baseRef}:${norm}`]);
      if (r.code !== 0) throw new WorkspaceError(`file not found in base: ${input.path}`);
      text = r.stdout;
    } else {
      const real = await this.resolveInside(norm);
      const stat = await fs.stat(real);
      if (!stat.isFile()) throw new WorkspaceError(`not a file: ${input.path}`);
      text = await fs.readFile(real, "utf8");
    }
    if (text.includes("\0")) throw new WorkspaceError(`binary file: ${input.path}`);

    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = Math.max(1, Math.floor(input.startLine ?? 1));
    if (start > Math.max(total, 1)) {
      throw new WorkspaceError(`startLine ${start} beyond end of file (${total} lines)`);
    }
    const requestedEnd = Math.min(total, Math.floor(input.endLine ?? start + L.readMaxLines - 1));
    if (requestedEnd < start && total > 0) throw new WorkspaceError("endLine < startLine");
    let end = requestedEnd;
    let truncated = false;
    if (end - start + 1 > L.readMaxLines) {
      end = start + L.readMaxLines - 1;
      truncated = true;
    }
    const out: string[] = [];
    let chars = 0;
    for (let n = start; n <= end; n++) {
      const line = `${n}\t${lines[n - 1]}`;
      if (chars + line.length + 1 > L.readMaxChars) {
        end = n - 1;
        truncated = true;
        break;
      }
      chars += line.length + 1;
      out.push(line);
    }
    return { path: norm, ref, startLine: start, endLine: end, totalLines: total, content: out.join("\n"), truncated };
  }

  private globSpec(glob: string): string {
    return `:(glob)${normalizeRepoPath(glob)}`;
  }

  private async gitGrep(flags: string[], pattern: string, pathspec: string | undefined, max: number) {
    const args = ["grep", "-n", "-I", "--no-color", ...flags, "-e", pattern, "--"];
    if (pathspec) args.push(pathspec);
    const r = await git(this.root, args, L.grepTimeoutMs);
    if (r.code > 1) throw new WorkspaceError("git grep failed (invalid pattern?)");
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
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
    const r = await git(this.root, ["ls-files", "-z"]);
    if (r.code !== 0) throw new WorkspaceError("git ls-files failed");
    let files = r.stdout.split("\0").filter(Boolean);
    if (input.glob) {
      const isMatch = picomatch(normalizeRepoPath(input.glob), { dot: true });
      files = files.filter((f) => isMatch(f));
    }
    files.sort();
    return { files: files.slice(0, L.listMaxFiles), truncated: files.length > L.listMaxFiles };
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
        path: m[1],
        line: Number(m[2]),
        kind: "reference",
        confidence: "name",
        text: truncateLine(m[3].trim()),
      });
    }
    return { references, truncated };
  }
}
