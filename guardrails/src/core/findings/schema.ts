import { z } from "zod";

/** Finding schema v2 (PLAN-DETAILED §3.7). The legacy v1 schema stays in `../types.ts`. */
export const evidenceSchema = z.object({
  file: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  note: z.string().max(200),
});

export const findingSchemaV2 = z.object({
  file: z.string(),
  /** Last line, RIGHT side of the diff. */
  line: z.number().int(),
  /** First line for multi-line comments. */
  startLine: z.number().int().optional(),
  type: z.enum(["logic", "security", "syntax", "style"]),
  severity: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  title: z.string().max(120),
  body: z.string().max(1500),
  suggestion: z.string().max(2000).optional(),
  ruleId: z.string().optional(),
  evidence: z.array(evidenceSchema).min(1).max(5),
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type FindingV2 = z.infer<typeof findingSchemaV2>;

/** One verdict of the per-rule pass: was rule `ruleId` violated (in `file` when given), fine, or not applicable to the change. */
export const ruleCheckSchema = z.object({
  ruleId: z.string(),
  file: z.string().optional(),
  verdict: z.enum(["violated", "ok", "not-applicable"]),
  note: z.string().max(200).optional(),
});
export type RuleCheck = z.infer<typeof ruleCheckSchema>;

/** Tool-terminal payload for `report_findings`. */
export const reportFindingsSchema = z.object({
  findings: z.array(findingSchemaV2).max(20),
  notes: z.string().max(500).optional(),
  /** Exhaustive pass: one verdict per active rule (and changed file) that has no mechanical check. */
  ruleChecks: z.array(ruleCheckSchema).max(100).optional(),
});
