export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
  type: "add" | "del" | "context";
  content: string;
  /** Line number in the old file (null for additions). */
  oldLine: number | null;
  /** Line number in the new file (null for deletions). */
  newLine: number | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@` (usually the enclosing function). */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Path in the new tree (old path for deletions). */
  path: string;
  /** Path in the old tree (equals `path` unless renamed; null for added files). */
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  /** New-file line numbers of `+` lines, ascending. */
  addedLines: number[];
  /** New-file lines GitHub accepts for RIGHT-side inline comments: `+` and context lines. */
  commentableLines: number[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPrefix(p: string): string | null {
  if (p === "/dev/null") return null;
  const unquoted = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return unquoted.replace(/^[ab]\//, "").replace(/\t.*$/, "");
}

interface Draft {
  oldPath: string | null;
  newPath: string | null;
  renameFrom?: string;
  renameTo?: string;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  hunks: Hunk[];
}

function finish(d: Draft): FileDiff | null {
  const oldPath = d.renameFrom ?? d.oldPath;
  const newPath = d.renameTo ?? d.newPath;
  const path = newPath ?? oldPath;
  if (!path) return null;
  const status: FileStatus = d.isNew
    ? "added"
    : d.isDeleted
      ? "deleted"
      : oldPath && newPath && oldPath !== newPath
        ? "renamed"
        : "modified";
  const addedLines: number[] = [];
  const commentable: number[] = [];
  if (status !== "deleted") {
    for (const h of d.hunks) {
      for (const l of h.lines) {
        if (l.newLine === null) continue;
        commentable.push(l.newLine);
        if (l.type === "add") addedLines.push(l.newLine);
      }
    }
  }
  return {
    path,
    oldPath: status === "added" ? null : (oldPath ?? path),
    status,
    binary: d.binary,
    hunks: d.hunks,
    addedLines,
    commentableLines: commentable,
  };
}

/**
 * Parses a unified diff (`git diff` output, or plain `--- a/x` / `+++ b/x` sections).
 * Tolerant of truncated hunks. Never throws.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const rows = text.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();

  const files: FileDiff[] = [];
  let cur: Draft | null = null;
  let hunk: Hunk | null = null;
  let oldRem = 0;
  let newRem = 0;
  let oldNo = 0;
  let newNo = 0;

  const start = (): Draft => ({
    oldPath: null,
    newPath: null,
    isNew: false,
    isDeleted: false,
    binary: false,
    hunks: [],
  });
  const flush = () => {
    if (cur) {
      const f = finish(cur);
      if (f) files.push(f);
    }
    cur = null;
    hunk = null;
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;

    // Inside a hunk body: consume by counts so `--- foo` deleted content is not a header.
    if (hunk && (oldRem > 0 || newRem > 0)) {
      const c = row[0];
      if (c === "+" && newRem > 0) {
        hunk.lines.push({ type: "add", content: row.slice(1), oldLine: null, newLine: newNo++ });
        newRem--;
        continue;
      }
      if (c === "-" && oldRem > 0) {
        hunk.lines.push({ type: "del", content: row.slice(1), oldLine: oldNo++, newLine: null });
        oldRem--;
        continue;
      }
      if ((c === " " || row === "") && oldRem > 0 && newRem > 0) {
        hunk.lines.push({ type: "context", content: row.slice(1), oldLine: oldNo++, newLine: newNo++ });
        oldRem--;
        newRem--;
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file"
      // Anything else: malformed/truncated hunk; fall through to header handling.
      oldRem = newRem = 0;
    } else if (row.startsWith("\\")) {
      continue;
    }

    if (row.startsWith("diff --git ")) {
      flush();
      cur = start();
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(row);
      if (m) {
        cur.oldPath = m[1]!;
        cur.newPath = m[2]!;
      }
      continue;
    }

    const h = HUNK_RE.exec(row);
    if (h) {
      if (!cur) cur = start();
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        header: h[5] ?? "",
        lines: [],
      };
      cur.hunks.push(hunk);
      oldRem = hunk.oldLines;
      newRem = hunk.newLines;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }

    if (row.startsWith("--- ")) {
      // Plain (non-git) diffs have no `diff --git` line: a `---` after hunks starts a new file.
      if (!cur || cur.hunks.length > 0) {
        flush();
        cur = start();
      }
      const old = stripPrefix(row.slice(4));
      cur.oldPath = old;
      if (old === null) cur.isNew = true;
      continue;
    }
    if (!cur) continue;
    if (row.startsWith("+++ ")) {
      const nw = stripPrefix(row.slice(4));
      cur.newPath = nw;
      if (nw === null) cur.isDeleted = true;
      if (nw !== null && cur.oldPath === null) cur.isNew = true;
      // In plain diffs old path may be /dev/null; keep path from new.
      continue;
    }
    if (row.startsWith("new file mode")) cur.isNew = true;
    else if (row.startsWith("deleted file mode")) cur.isDeleted = true;
    else if (row.startsWith("rename from ")) cur.renameFrom = row.slice(12);
    else if (row.startsWith("rename to ")) cur.renameTo = row.slice(10);
    else if (row.startsWith("Binary files ") || row.startsWith("GIT binary patch")) cur.binary = true;
  }
  flush();
  return files;
}
