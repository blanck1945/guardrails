import { DEFAULT_IGNORES, isIgnored } from "../paths";
import type { Workspace } from "../workspace";
import { isSecretPath, redactSecrets } from "./secrets";

/** Size caps. Everything is deterministic: no LLM is involved in collection. */
export const INIT_LIMITS = {
  /** Default cap per file (chars). */
  maxFileChars: 12_000,
  /** Total cap over all files (chars); lower-priority files are truncated or skipped first. */
  maxTotalChars: 80_000,
  /** Max files read per group of globs. */
  maxFilesPerGroup: 8,
  /** Max files considered when deriving the folder structure. */
  maxStructureFiles: 20_000,
  maxStructureLines: 120,
  maxRootFiles: 40,
} as const;

export type SourceKind = "instructions" | "lessons" | "contributing" | "lint" | "ci" | "readme";

interface Group {
  kind: SourceKind;
  globs: string[];
  maxChars?: number;
}

/** Ordered by priority: earlier groups win when the total budget runs out. */
const GROUPS: Group[] = [
  {
    kind: "instructions",
    globs: [
      "CLAUDE.md",
      "AGENTS.md",
      ".cursorrules",
      ".cursor/rules/*",
      ".github/copilot-instructions.md",
      "*/CLAUDE.md",
      "*/AGENTS.md",
    ],
  },
  {
    kind: "lessons",
    globs: [
      "docs/lessons*",
      "docs/LESSONS*",
      "LESSONS.md",
      "lessons.md",
      "docs/**/lessons*.md",
      "docs/conventions*",
      "docs/CONVENTIONS*",
      "CONVENTIONS.md",
      "STYLEGUIDE.md",
      "docs/style*",
    ],
  },
  { kind: "contributing", globs: ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md"], maxChars: 8_000 },
  {
    kind: "lint",
    maxChars: 5_000,
    globs: [
      "tsconfig*.json",
      "*/tsconfig*.json",
      ".eslintrc*",
      "eslint.config.*",
      ".oxlintrc.json",
      "biome.json",
      "biome.jsonc",
      "ruff.toml",
      ".ruff.toml",
      "pyproject.toml",
      ".prettierrc*",
      "prettier.config.*",
      ".golangci.y*ml",
      "rustfmt.toml",
      "clippy.toml",
    ],
  },
  { kind: "ci", maxChars: 4_000, globs: [".github/workflows/*.yml", ".github/workflows/*.yaml", ".gitlab-ci.yml"] },
  { kind: "readme", globs: ["README.md", "README"], maxChars: 6_000 },
];

export interface CollectedFile {
  path: string;
  kind: SourceKind;
  content: string;
  truncated: boolean;
}

export interface RepoContext {
  files: CollectedFile[];
  /** Human-readable first/second-level folder summary. */
  structure: string;
  /** Files that matched but were not read, with the reason. */
  skipped: { path: string; reason: "secret" | "ignored" | "unreadable" | "budget" }[];
  totalChars: number;
  /** Tracked (versioned) files, minus secret paths; used to validate rule scopes. Absent = not validated. */
  trackedFiles?: string[];
}

/** Reads a whole file through the workspace's paginated readFile, up to `maxChars`. */
async function readCapped(ws: Workspace, path: string, maxChars: number) {
  let text = "";
  let truncated = false;
  let start = 1;
  for (;;) {
    const page = await ws.readFile({ path, startLine: start });
    const lines = page.content ? page.content.split("\n").map((l) => l.replace(/^\d+\t/, "")) : [];
    text += (text ? "\n" : "") + lines.join("\n");
    if (text.length > maxChars) break;
    if (page.endLine >= page.totalLines) break;
    start = page.endLine + 1;
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text, truncated };
}

function summarizeStructure(files: string[]): string {
  const top = new Map<string, number>();
  const second = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length === 1) {
      rootFiles.push(f);
      continue;
    }
    top.set(parts[0]!, (top.get(parts[0]!) ?? 0) + 1);
    if (parts.length > 2) {
      const key = `${parts[0]}/${parts[1]}`;
      second.set(key, (second.get(key) ?? 0) + 1);
    }
  }
  const lines: string[] = [];
  for (const [dir, n] of [...top].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${dir}/ (${n} files)`);
    for (const [sub, m] of [...second].sort(([a], [b]) => a.localeCompare(b))) {
      if (sub.startsWith(dir + "/")) lines.push(`  ${sub.slice(dir.length + 1)}/ (${m})`);
    }
  }
  const capped = lines.slice(0, INIT_LIMITS.maxStructureLines);
  if (lines.length > capped.length) capped.push(`... (${lines.length - capped.length} more)`);
  const roots = rootFiles.slice(0, INIT_LIMITS.maxRootFiles);
  return [`Root files: ${roots.join(", ")}${rootFiles.length > roots.length ? ", ..." : ""}`, ...capped].join("\n");
}

/**
 * Deterministic repo scan for `guardrails init`. Reads only tracked, non-ignored, non-secret files
 * from a fixed candidate list, with per-file and total size caps.
 */
export async function collectRepoContext(ws: Workspace): Promise<RepoContext> {
  const skipped: RepoContext["skipped"] = [];
  const files: CollectedFile[] = [];
  let total = 0;
  const seen = new Set<string>();

  const groupMatches = await Promise.all(
    GROUPS.map(async (g) => {
      const found = new Set<string>();
      for (const glob of g.globs) {
        try {
          for (const f of (await ws.listFiles({ glob, limit: 100 })).files) found.add(f);
        } catch {
          /* pattern not supported or listing failed: ignore it */
        }
      }
      return [...found].sort();
    }),
  );

  for (const [i, g] of GROUPS.entries()) {
    for (const p of groupMatches[i]!.slice(0, INIT_LIMITS.maxFilesPerGroup)) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (isSecretPath(p)) {
        skipped.push({ path: p, reason: "secret" });
        continue;
      }
      if (isIgnored(p, DEFAULT_IGNORES)) {
        skipped.push({ path: p, reason: "ignored" });
        continue;
      }
      const room = INIT_LIMITS.maxTotalChars - total;
      if (room < 500) {
        skipped.push({ path: p, reason: "budget" });
        continue;
      }
      try {
        const cap = Math.min(g.maxChars ?? INIT_LIMITS.maxFileChars, room);
        const { text, truncated } = await readCapped(ws, p, cap);
        const content = redactSecrets(text);
        files.push({ path: p, kind: g.kind, content, truncated });
        total += content.length;
      } catch {
        skipped.push({ path: p, reason: "unreadable" });
      }
    }
  }

  let structure = "";
  let trackedFiles: string[] | undefined;
  try {
    const all = await ws.listFiles({ limit: INIT_LIMITS.maxStructureFiles });
    // A truncated listing cannot prove a scope matches nothing, so scopes are only validated against a complete one.
    if (!all.truncated) trackedFiles = all.files.filter((f) => !isSecretPath(f));
    structure = summarizeStructure(all.files.filter((f) => !isSecretPath(f) && !isIgnored(f, DEFAULT_IGNORES)));
  } catch {
    /* structure is optional */
  }
  return { files, structure, skipped, totalChars: total, ...(trackedFiles ? { trackedFiles } : {}) };
}
