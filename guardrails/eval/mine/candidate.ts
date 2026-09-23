import { z } from "zod";

/** eval/candidates/<repo>-<fixPr>.json: raw SZZ output, before human curation (B11). */

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const range = z.tuple([z.number().int().positive(), z.number().int().positive()]);

const prRef = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  mergedAt: z.string(),
  mergeCommitSha: sha.nullable(),
  baseSha: sha,
  headSha: sha,
});

export const candidateSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  repo: z.string(),
  language: z.enum(["ts", "js", "tsx", "py"]),
  minedAt: z.string(),
  fix: prRef.extend({
    labels: z.array(z.string()),
    /** Parent of the fix commit: the state the SZZ blame ran on. */
    parentSha: sha,
  }),
  introducing: z.object({
    /** Commit that owns most of the blamed lines. */
    commitSha: sha,
    commitDate: z.string(),
    pr: prRef.extend({
      changedFiles: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  }),
  /** Bug lines, in the coordinates of `introducing.commitSha` (line numbers of that commit's file version). */
  bugLines: z.array(
    z.object({
      file: z.string(),
      ranges: z.array(range).min(1),
      /** Lines the fix removed or modified in this file, old-side coordinates (fix parent). */
      fixFile: z.string(),
      fixRanges: z.array(range).min(1),
    }),
  ),
  blamedLines: z.number().int().positive(),
  daysToFix: z.number().nonnegative(),
});

export type Candidate = z.infer<typeof candidateSchema>;
