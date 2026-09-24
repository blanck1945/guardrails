/** Limits from PLAN-DETAILED §3.3. */
export const WORKSPACE_LIMITS = {
  readMaxLines: 300,
  readMaxChars: 24_000,
  grepMaxMatches: 60,
  grepMaxLineChars: 200,
  grepTimeoutMs: 10_000,
  listMaxFiles: 300,
  referencesMaxMatches: 40,
} as const;

export type Ref = "head" | "base";

export type ReadFileInput = {
  path: string;
  /** 1-based, inclusive. Defaults to 1. */
  startLine?: number;
  /** 1-based, inclusive. Defaults to startLine + 299. */
  endLine?: number;
  ref?: Ref;
};

export type ReadFileResult = {
  path: string;
  ref: Ref;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** Numbered lines: `<n>\t<text>`. */
  content: string;
  truncated: boolean;
};

export type GrepInput = {
  /** Regex (ERE) unless `fixed` is true. */
  pattern: string;
  pathGlob?: string;
  ignoreCase?: boolean;
  fixed?: boolean;
};

export type GrepResult = {
  /** `path:line:text` */
  matches: string[];
  truncated: boolean;
};

export type ListFilesInput = {
  glob?: string;
  /** Max files returned. Defaults to `WORKSPACE_LIMITS.listMaxFiles`; internal callers (init) may raise it. */
  limit?: number;
};
export type ListFilesResult = { files: string[]; truncated: boolean };

export type ReferencesInput = { symbol: string; path?: string };
export type Reference = {
  path: string;
  line: number;
  kind: "reference";
  /** `name` = matched by identifier text only (no resolution). */
  confidence: "name";
  text: string;
};
export type ReferencesResult = { references: Reference[]; truncated: boolean };

export interface Workspace {
  readFile(input: ReadFileInput): Promise<ReadFileResult>;
  grep(input: GrepInput): Promise<GrepResult>;
  listFiles(input?: ListFilesInput): Promise<ListFilesResult>;
  /** Unified diff between the base and head refs. */
  diff(): Promise<string>;
  findReferencesByName(input: ReferencesInput): Promise<ReferencesResult>;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}
