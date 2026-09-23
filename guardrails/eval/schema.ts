import { z } from "zod";

/** case.json per PLAN-DETAILED §7.1. */

const sha = z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-char lowercase hex SHA");

export const bugSchema = z
  .object({
    file: z.string().min(1),
    /** [start, end], 1-based, inclusive. */
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    description: z.string().min(1),
    severity: z.enum(["high", "medium", "low"]),
    /** Free-form (e.g. logic, security, performance); the plan does not fix a closed set. */
    category: z.string().min(1),
    crossFile: z.boolean(),
    relatedFiles: z.array(z.string().min(1)).default([]),
  })
  .refine((b) => b.lines[0] <= b.lines[1], { message: "lines[0] must be <= lines[1]", path: ["lines"] });

export const caseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "id must be lowercase [a-z0-9._-]"),
    repo: z.string().regex(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/, "expected https://github.com/<owner>/<repo>"),
    baseSha: sha,
    headSha: sha,
    source: z.enum(["szz", "injected", "clean", "injection"]),
    language: z.enum(["ts", "js", "tsx", "py"]),
    validated: z.boolean(),
    bugs: z.array(bugSchema),
  })
  .superRefine((c, ctx) => {
    if (c.source === "clean" && c.bugs.length > 0) {
      ctx.addIssue({ code: "custom", path: ["bugs"], message: "clean cases must have no bugs" });
    }
    if (c.source !== "clean" && c.bugs.length === 0) {
      ctx.addIssue({ code: "custom", path: ["bugs"], message: `${c.source} cases need at least one bug` });
    }
    if (c.baseSha === c.headSha) {
      ctx.addIssue({ code: "custom", path: ["headSha"], message: "headSha must differ from baseSha" });
    }
  });

export type Case = z.infer<typeof caseSchema>;

export const repoEntrySchema = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  url: z.string().url(),
  language: z.enum(["ts", "js", "py"]),
  role: z.enum(["cases", "latency"]),
  license: z.string().min(1),
  commitsLast28d: z.number().int().nonnegative().optional(),
  bugLabel: z.string().min(1).optional(),
  /** true when activity/license/label could not be checked (e.g. no network). */
  unverified: z.boolean().optional(),
  note: z.string().optional(),
});

export const reposFileSchema = z.object({
  checkedAt: z.string(),
  criteria: z.string(),
  repos: z.array(repoEntrySchema).min(1),
  excluded: z.array(z.object({ repo: z.string(), reason: z.string() })).default([]),
});

export type ReposFile = z.infer<typeof reposFileSchema>;
