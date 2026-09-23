import { parseUnifiedDiff } from "@/core/diff";

export { parseUnifiedDiff } from "@/core/diff";
export type { FileDiff, Hunk, DiffLine, FileStatus } from "@/core/diff";

/**
 * Lines (new-file numbering) that GitHub accepts for inline comments, from the `patch`
 * of one file as returned by the pulls.listFiles API (hunks only, no file header).
 */
export function commentableLines(patch: string | undefined): Set<number> {
  if (!patch) return new Set();
  const [file] = parseUnifiedDiff(`--- a/f\n+++ b/f\n${patch}`);
  return new Set(file?.commentableLines ?? []);
}
