import { createHash } from "node:crypto";
import type { FindingV2 } from "./schema";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Text of the anchored line (1-based) in the file, trimmed; "" if out of range. */
export function anchorText(fileContent: string, line: number): string {
  return (fileContent.split("\n")[line - 1] ?? "").trim();
}

/**
 * fingerprint = sha1(repoId | file | ruleId ?? type | normalize(title) | sha1(trim(anchored line)))
 * Line numbers are deliberately excluded, so it survives line shifts.
 */
export function fingerprint(
  repoId: string | number,
  f: Pick<FindingV2, "file" | "type" | "title"> & Partial<FindingV2>,
  anchor: string,
): string {
  return sha1(
    [repoId, f.file, f.ruleId ?? f.type, normalizeTitle(f.title), sha1(anchor.trim())].join("|"),
  );
}
