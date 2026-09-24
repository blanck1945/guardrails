import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import picomatch from "picomatch";
import safeRegex from "safe-regex2";
import * as tar from "tar";
import { DEFAULT_IGNORES } from "../paths";
import { formatReadResult, truncateLine } from "./format";
import { normalizeRepoPath } from "./local";
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
  type Ref,
  type Workspace,
} from "./types";

export interface TarballLimits {
  /** Total bytes extracted per tree. */
  maxBytes: number;
  /** Total files extracted per tree. */
  maxFiles: number;
  /** Files above this size are omitted (not an error). */
  maxFileBytes: number;
  /** Download timeout (ms), enforced with an AbortSignal. */
  timeoutMs: number;
}

export const DEFAULT_TARBALL_LIMITS: TarballLimits = {
  maxBytes: 150 * 1024 * 1024,
  maxFiles: 20_000,
  maxFileBytes: 1024 * 1024,
  timeoutMs: 60_000,
};

/** The repository exceeds the extraction limits (bytes or file count). */
export class RepoTooLargeError extends Error {
  constructor(
    readonly reason: "bytes" | "files" | "download",
    readonly limit: number,
  ) {
    super(`repository too large: exceeds ${reason} limit (${limit})`);
    this.name = "RepoTooLargeError";
  }
}

/** The tarball could not be downloaded in time or at all. Never carries the request (it holds a token). */
export class TarballDownloadError extends Error {
  constructor(readonly kind: "timeout" | "failed") {
    super(kind === "timeout" ? "tarball download timed out" : "tarball download failed");
    this.name = "TarballDownloadError";
  }
}

/** The slice of Octokit used here; a real Octokit satisfies it structurally (see `asTarballOctokit`). */
export interface TarballOctokit {
  request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
}

export function asTarballOctokit(octo: unknown): TarballOctokit {
  return octo as TarballOctokit;
}

export interface ExtractStats {
  files: number;
  bytes: number;
  skipped: { ignored: number; large: number; links: number; rejected: number; other: number };
  /** Repo-relative paths omitted for being larger than `maxFileBytes` (capped list). */
  omittedLarge: string[];
}

const HEAVY_DIRS = new Set([".git", "node_modules"]);
const ignoreMatchers = DEFAULT_IGNORES.map((pat) => picomatch(pat, { dot: true, basename: !pat.includes("/") }));

/** True when a repo-relative path (after strip) must not be extracted. */
function isHeavy(rel: string): boolean {
  if (rel.split("/").some((c) => HEAVY_DIRS.has(c))) return true;
  return ignoreMatchers.some((m) => m(rel));
}

/** Raw tar path safety: no `..` components, no absolute or drive paths, no NUL. */
function isUnsafeEntryPath(raw: string): boolean {
  if (raw.includes("\0")) return true;
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return true;
  return p.split("/").includes("..");
}

/**
 * Extracts a (gzipped) tarball into `destDir` with `strip: 1`. Only regular files are written: symlinks,
 * hardlinks and special entries are dropped, as are `.git`, `node_modules`, default-ignored paths and
 * files above `maxFileBytes`. Exceeding `maxBytes`/`maxFiles` aborts with `RepoTooLargeError`.
 */
export async function extractTarball(
  data: Uint8Array,
  destDir: string,
  limits: Partial<TarballLimits> = {},
): Promise<ExtractStats> {
  const lim = { ...DEFAULT_TARBALL_LIMITS, ...limits };
  const stats: ExtractStats = {
    files: 0,
    bytes: 0,
    skipped: { ignored: 0, large: 0, links: 0, rejected: 0, other: 0 },
    omittedLarge: [],
  };
  // Bytes that were only scanned (skipped entries) also count, so a huge ignored tree cannot burn the time budget.
  let scanned = 0;
  let tooLarge: RepoTooLargeError | undefined;
  const abort = new AbortController();
  // Overflow of files/bytes only flags the error: the remaining entries are skipped and the stream ends normally,
  // so no write is left in flight. Only the decompression-bomb guard aborts the stream.
  const fail = (e: RepoTooLargeError, hard = false) => {
    tooLarge ??= e;
    if (hard) abort.abort();
  };

  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  const unpack = tar.x({
    cwd: destDir,
    strip: 1,
    dmode: 0o700,
    fmode: 0o600,
    // Ownership from the archive is never applied.
    preserveOwner: false,
    filter: (rawPath, entry) => {
      if (tooLarge) return false;
      const type = (entry as { type?: string }).type ?? "";
      const size = (entry as { size?: number }).size ?? 0;
      if (type === "SymbolicLink" || type === "Link") {
        stats.skipped.links++;
        return false;
      }
      if (isUnsafeEntryPath(rawPath)) {
        stats.skipped.rejected++;
        return false;
      }
      if (type === "Directory") return false; // parents are created by the files inside
      if (type !== "File" && type !== "OldFile" && type !== "ContiguousFile") {
        stats.skipped.other++;
        return false;
      }
      scanned += size;
      if (scanned > lim.maxBytes * 4) {
        fail(new RepoTooLargeError("bytes", lim.maxBytes), true);
        return false;
      }
      const rel = rawPath.replace(/\\/g, "/").split("/").filter((c) => c && c !== ".").slice(1).join("/");
      if (!rel) return false;
      if (isHeavy(rel)) {
        stats.skipped.ignored++;
        return false;
      }
      if (size > lim.maxFileBytes) {
        stats.skipped.large++;
        if (stats.omittedLarge.length < 1000) stats.omittedLarge.push(rel);
        return false;
      }
      if (stats.files + 1 > lim.maxFiles) {
        fail(new RepoTooLargeError("files", lim.maxFiles));
        return false;
      }
      if (stats.bytes + size > lim.maxBytes) {
        fail(new RepoTooLargeError("bytes", lim.maxBytes));
        return false;
      }
      stats.files++;
      stats.bytes += size;
      return true;
    },
  });
  let closed = false;
  unpack.on("close", () => (closed = true));
  try {
    await pipeline(Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)]), unpack, {
      signal: abort.signal,
    });
  } catch (err) {
    // After an abort, give in-flight file writes a moment to settle so the caller can delete the directory safely.
    for (let i = 0; i < 40 && !closed; i++) await new Promise((r) => setTimeout(r, 25));
    if (tooLarge) throw tooLarge;
    throw new WorkspaceError(`could not extract tarball: ${err instanceof Error ? err.name : "unknown"}`);
  }
  if (tooLarge) throw tooLarge;
  return stats;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TarballDownloadError("failed");
}

export interface DownloadRepoTarballOptions {
  octokit: TarballOctokit;
  owner: string;
  repo: string;
  /** Commit sha, branch, or `refs/pull/N/head`. */
  ref: string;
  destDir: string;
  limits?: Partial<TarballLimits>;
  /** Extra cancellation (for example the review-wide timeout). */
  signal?: AbortSignal;
}

/**
 * Downloads `owner/repo@ref` as a tarball through the GitHub API (the installation token lives in the Octokit
 * instance) and extracts it into `destDir`.
 *
 * The API response is buffered in memory before extraction: fine under the size caps, and the compressed size is
 * capped too.
 */
export async function downloadRepoTarball(opts: DownloadRepoTarballOptions): Promise<ExtractStats> {
  const lim = { ...DEFAULT_TARBALL_LIMITS, ...opts.limits };
  const timeout = AbortSignal.timeout(lim.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let bytes: Uint8Array;
  try {
    // `{+ref}` keeps the slashes of `refs/pull/N/head` unescaped.
    const res = await opts.octokit.request("GET /repos/{owner}/{repo}/tarball/{+ref}", {
      owner: opts.owner,
      repo: opts.repo,
      ref: opts.ref,
      request: { signal, redirect: "follow" },
    });
    bytes = toBytes(res.data);
  } catch (err) {
    if (err instanceof TarballDownloadError) throw err;
    if (timeout.aborted) throw new TarballDownloadError("timeout");
    if (signal.aborted) throw err; // caller cancelled: let the caller's own error surface
    throw new TarballDownloadError("failed");
  }
  if (bytes.byteLength > lim.maxBytes) throw new RepoTooLargeError("download", lim.maxBytes);
  return extractTarball(bytes, opts.destDir, lim);
}

export interface TarballWorkspaceOptions {
  /** Directory that owns `baseDir` and `headDir`; `dispose()` deletes it. */
  rootDir: string;
  baseDir: string;
  headDir: string;
  /** Unified diff of the PR (from the GitHub API patches). */
  diff?: string;
  /** Paths omitted from each tree for being too large, to give a clearer error. */
  omitted?: { base?: string[]; head?: string[] };
  /** Time budget per `grep`/`findReferencesByName` call. Default 2000 ms. */
  grepBudgetMs?: number;
}

export interface CreateTarballWorkspaceOptions {
  octokit: TarballOctokit;
  owner: string;
  repo: string;
  baseRef: string;
  /** Commit sha, or `refs/pull/N/head` for PRs from forks. */
  headRef: string;
  diff?: string;
  limits?: Partial<TarballLimits>;
  signal?: AbortSignal;
  grepBudgetMs?: number;
  /** Parent for the random temp directory. Default `os.tmpdir()`. */
  tmpRoot?: string;
}

const MAX_PATTERN_CHARS = 200;
/** Lines longer than this are cut before matching: bounds the cost of one regex run. */
const MAX_MATCH_LINE_CHARS = 2000;
const DEFAULT_GREP_BUDGET_MS = 2000;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Hit = { path: string; line: number; text: string };

/**
 * `Workspace` over two extracted trees (base and head), with no `git`: for runtimes such as Vercel functions.
 * Read-only: nothing from the repository is ever executed.
 */
export class TarballWorkspace implements Workspace {
  private readonly rootDir: string;
  private readonly dirs: Record<Ref, string>;
  private readonly omitted: Record<Ref, Set<string>>;
  private readonly diffText: string;
  private readonly grepBudgetMs: number;
  private readonly fileLists: Partial<Record<Ref, string[]>> = {};
  private realDirs: Partial<Record<Ref, string>> = {};
  private disposed = false;

  constructor(opts: TarballWorkspaceOptions) {
    this.rootDir = opts.rootDir;
    this.dirs = { base: path.resolve(opts.baseDir), head: path.resolve(opts.headDir) };
    this.omitted = { base: new Set(opts.omitted?.base ?? []), head: new Set(opts.omitted?.head ?? []) };
    this.diffText = opts.diff ?? "";
    this.grepBudgetMs = opts.grepBudgetMs ?? DEFAULT_GREP_BUDGET_MS;
  }

  /**
   * Downloads base and head into a fresh 0700 directory under the temp dir. On any failure the directory is
   * removed before the error propagates; on success the caller must `dispose()` (in a `finally`).
   */
  static async create(opts: CreateTarballWorkspaceOptions): Promise<TarballWorkspace> {
    const parent = opts.tmpRoot ?? tmpdir();
    const rootDir = path.join(parent, `guardrails-${randomBytes(12).toString("hex")}`);
    await fs.mkdir(rootDir, { mode: 0o700 });
    try {
      const baseDir = path.join(rootDir, "base");
      const headDir = path.join(rootDir, "head");
      const common = { octokit: opts.octokit, owner: opts.owner, repo: opts.repo, limits: opts.limits, signal: opts.signal };
      // allSettled: a failed side must not leave the other one writing into a directory we are about to delete.
      const [base, head] = await Promise.allSettled([
        downloadRepoTarball({ ...common, ref: opts.baseRef, destDir: baseDir }),
        downloadRepoTarball({ ...common, ref: opts.headRef, destDir: headDir }),
      ]);
      if (base.status === "rejected") throw base.reason;
      if (head.status === "rejected") throw head.reason;
      return new TarballWorkspace({
        rootDir,
        baseDir,
        headDir,
        diff: opts.diff,
        omitted: { base: base.value.omittedLarge, head: head.value.omittedLarge },
        grepBudgetMs: opts.grepBudgetMs,
      });
    } catch (err) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /** Deletes the temporary directories. Idempotent; call it in a `finally`. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await fs.rm(this.rootDir, { recursive: true, force: true });
  }

  private assertLive(): void {
    if (this.disposed) throw new WorkspaceError("workspace disposed");
  }

  private async realDir(ref: Ref): Promise<string> {
    return (this.realDirs[ref] ??= await fs.realpath(this.dirs[ref]));
  }

  /** Resolves a repo-relative path to a real file inside the tree (realpath check, like LocalWorkspace). */
  private async resolveInside(rel: string, ref: Ref): Promise<string> {
    const norm = normalizeRepoPath(rel);
    const realRoot = await this.realDir(ref);
    let real: string;
    try {
      real = await fs.realpath(path.join(realRoot, norm));
    } catch {
      throw new WorkspaceError(`file not found${ref === "base" ? " in base" : ""}: ${rel}`);
    }
    const relToRoot = path.relative(realRoot, real);
    if (relToRoot === ".." || relToRoot.startsWith(".." + path.sep) || path.isAbsolute(relToRoot)) {
      throw new WorkspaceError(`path resolves outside the repository: ${rel}`);
    }
    return real;
  }

  private async files(ref: Ref): Promise<string[]> {
    const cached = this.fileLists[ref];
    if (cached) return cached;
    const root = await this.realDir(ref);
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
        else if (e.isFile()) out.push(rel); // symlinks and specials are never listed
      }
    };
    await walk(root, "");
    out.sort();
    return (this.fileLists[ref] = out);
  }

  async readFile(input: ReadFileInput): Promise<ReadFileResult> {
    this.assertLive();
    const ref = input.ref ?? "head";
    const norm = normalizeRepoPath(input.path);
    if (this.omitted[ref].has(norm)) throw new WorkspaceError(`file omitted (too large): ${input.path}`);
    const real = await this.resolveInside(norm, ref);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new WorkspaceError(`not a file: ${input.path}`);
    const text = await fs.readFile(real, "utf8");
    return formatReadResult(text, norm, ref, input);
  }

  async listFiles(input: ListFilesInput = {}): Promise<ListFilesResult> {
    this.assertLive();
    let files = await this.files(input.ref ?? "head");
    if (input.glob) {
      const isMatch = picomatch(normalizeRepoPath(input.glob), { dot: true });
      files = files.filter((f) => isMatch(f));
    }
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? L.listMaxFiles)), 50_000);
    return { files: files.slice(0, limit), truncated: files.length > limit };
  }

  async diff(): Promise<string> {
    this.assertLive();
    return this.diffText;
  }

  /** Scans the head tree file by file, stopping at `max` hits or when the time budget runs out. */
  private async scan(re: RegExp, pathGlob: string | undefined, max: number): Promise<{ hits: Hit[]; truncated: boolean }> {
    const started = Date.now();
    const isMatch = pathGlob ? picomatch(normalizeRepoPath(pathGlob), { dot: true }) : undefined;
    const root = await this.realDir("head");
    const hits: Hit[] = [];
    for (const rel of await this.files("head")) {
      if (Date.now() - started >= this.grepBudgetMs) return { hits, truncated: true };
      if (isMatch && !isMatch(rel)) continue;
      let buf: Buffer;
      try {
        buf = await fs.readFile(path.join(root, rel));
      } catch {
        continue;
      }
      if (buf.subarray(0, 8000).includes(0)) continue; // binary, like `git grep -I`
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
        if (!re.test(line.length > MAX_MATCH_LINE_CHARS ? line.slice(0, MAX_MATCH_LINE_CHARS) : line)) continue;
        if (hits.length >= max) return { hits, truncated: true };
        hits.push({ path: rel, line: i + 1, text: line });
      }
    }
    return { hits, truncated: false };
  }

  async grep(input: GrepInput): Promise<GrepResult> {
    this.assertLive();
    if (!input.pattern) throw new WorkspaceError("empty pattern");
    if (input.pattern.length > MAX_PATTERN_CHARS) {
      throw new WorkspaceError(`pattern too long (max ${MAX_PATTERN_CHARS} characters)`);
    }
    const flags = input.ignoreCase ? "i" : "";
    const source = input.fixed ? escapeRegex(input.pattern) : input.pattern;
    let re: RegExp;
    try {
      re = new RegExp(source, flags);
    } catch {
      throw new WorkspaceError("invalid pattern");
    }
    if (!input.fixed && !safeRegex(re)) {
      throw new WorkspaceError("pattern rejected: it could take exponential time; use a simpler pattern or fixed: true");
    }
    const { hits, truncated } = await this.scan(re, input.pathGlob, L.grepMaxMatches);
    return { matches: hits.map((h) => truncateLine(`${h.path}:${h.line}:${h.text}`)), truncated };
  }

  async findReferencesByName(input: ReferencesInput): Promise<ReferencesResult> {
    this.assertLive();
    const symbol = input.symbol?.trim();
    if (!symbol || symbol.length > 200) throw new WorkspaceError("invalid symbol");
    // Whole-word literal, like `git grep -w -F`.
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(symbol)}(?![A-Za-z0-9_])`);
    const { hits, truncated } = await this.scan(re, input.path, L.referencesMaxMatches);
    const references: Reference[] = hits.map((h) => ({
      path: h.path,
      line: h.line,
      kind: "reference",
      confidence: "name",
      text: truncateLine(h.text.trim()),
    }));
    return { references, truncated };
  }
}
