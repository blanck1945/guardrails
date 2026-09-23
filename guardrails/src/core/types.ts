import { z } from "zod";

export const findingSchema = z.object({
  file: z.string(),
  line: z.number().int().describe("Line number in the new version of the file"),
  type: z.enum(["logic", "security", "syntax", "style"]),
  severity: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  title: z.string(),
  body: z.string().describe("What is wrong and why it matters"),
  suggestion: z.string().optional().describe("Replacement code for the line, if any"),
  ruleId: z.string().optional(),
});

export const reviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema),
});

export type Finding = z.infer<typeof findingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** Source-agnostic view of the code under review. No GitHub types here. */
export interface ReviewInput {
  diff: string;
  /** Extra files the model may need, path -> content. */
  context: Record<string, string>;
  /** Repo docs (CONTRIBUTING, style guide), path -> content. */
  docs: Record<string, string>;
  title?: string;
  description?: string;
}
