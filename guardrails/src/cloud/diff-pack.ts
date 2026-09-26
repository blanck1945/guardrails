/** A file of the PR with its textual patch. */
export interface PatchFile {
  filename: string;
  patch: string;
}

export interface PackedDiff {
  /** Diff of the files that fit, in the order of the PR; never contains a partial file. */
  diff: string;
  included: string[];
  /** Files that did not fit whole in the budget. */
  overBudget: string[];
}

/** The unified-diff text of one file, as the model and the checks read it. */
export const fileDiffText = (f: PatchFile): string => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`;

/**
 * Packs whole files into a character budget (D-028): PR order, a file that does not fit whole is left out and the
 * next ones are still tried, so a big file never hides small ones. A file is never cut in the middle.
 */
export function packDiff(files: readonly PatchFile[], maxChars: number): PackedDiff {
  const parts: string[] = [];
  const included: string[] = [];
  const overBudget: string[] = [];
  let used = 0;
  for (const f of files) {
    const text = fileDiffText(f);
    const cost = text.length + (parts.length ? 1 : 0);
    if (used + cost > maxChars) {
      overBudget.push(f.filename);
      continue;
    }
    parts.push(text);
    included.push(f.filename);
    used += cost;
  }
  return { diff: parts.join("\n"), included, overBudget };
}
