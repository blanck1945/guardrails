import {
  WORKSPACE_LIMITS as L,
  WorkspaceError,
  type ReadFileInput,
  type ReadFileResult,
  type Ref,
} from "./types";

/** Cuts a grep/reference line to the shared display limit. */
export function truncateLine(s: string): string {
  return s.length > L.grepMaxLineChars ? s.slice(0, L.grepMaxLineChars) + "..." : s;
}

/** Shared by every `Workspace`: numbered, range- and size-limited view of a text file. */
export function formatReadResult(text: string, norm: string, ref: Ref, input: ReadFileInput): ReadFileResult {
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
