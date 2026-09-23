import { z } from "zod";

export const ruleSchema = z.object({
  id: z.string(),
  rule: z.string(),
  scope: z.array(z.string()).default(["**"]),
  severity: z.enum(["low", "medium", "high"]).default("medium"),
});

export const configSchema = z.object({
  strictness: z.number().int().min(1).max(3).default(2),
  commentTypes: z
    .array(z.enum(["logic", "security", "syntax", "style"]))
    .default(["logic", "security", "syntax"]),
  ignorePatterns: z.array(z.string()).default([]),
  instructions: z.string().default(""),
  rules: z.array(ruleSchema).default([]),
  files: z.array(z.object({ path: z.string() })).default([]),
});

export type Rule = z.infer<typeof ruleSchema>;
export type GuardrailsConfig = z.infer<typeof configSchema>;

export const defaultConfig: GuardrailsConfig = configSchema.parse({});

export function parseConfig(raw: string | null | undefined): GuardrailsConfig {
  if (!raw) return defaultConfig;
  return configSchema.parse(JSON.parse(raw));
}
