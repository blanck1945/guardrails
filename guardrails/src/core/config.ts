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
  packs: z.array(z.string()).default([]),
  disabledRules: z.array(z.string()).default([]),
  triggers: z
    .object({
      drafts: z.boolean().default(false),
      forks: z.boolean().default(true),
      skipLabels: z.array(z.string()).default(["skip-guardrails"]),
    })
    .default({ drafts: false, forks: true, skipLabels: ["skip-guardrails"] }),
});

export type Rule = z.infer<typeof ruleSchema>;
export type GuardrailsConfig = z.infer<typeof configSchema>;

export const defaultConfig: GuardrailsConfig = configSchema.parse({});

export interface ConfigError {
  /** Dotted path of the offending field ("" for the whole document). */
  path: string;
  message: string;
}

export interface SafeConfigResult {
  config: GuardrailsConfig;
  errors: ConfigError[];
}

/**
 * Never throws. Invalid JSON -> defaults + 1 error. An invalid field falls back to
 * that field's default and reports an error carrying its path.
 */
export function safeParseConfig(raw: string | null | undefined): SafeConfigResult {
  if (!raw || !raw.trim()) return { config: defaultConfig, errors: [] };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return {
      config: defaultConfig,
      errors: [{ path: "", message: `Invalid JSON: ${(e as Error).message}` }],
    };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { config: defaultConfig, errors: [{ path: "", message: "Config must be a JSON object" }] };
  }

  const errors: ConfigError[] = [];
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    const field = (configSchema.shape as Record<string, z.ZodType>)[key];
    if (!field) continue; // unknown keys are ignored
    const res = field.safeParse(value);
    if (res.success) {
      clean[key] = res.data;
    } else {
      for (const issue of res.error.issues) {
        errors.push({ path: [key, ...issue.path].join("."), message: issue.message });
      }
    }
  }
  return { config: configSchema.parse(clean), errors };
}

/** Lenient wrapper kept for callers that only need the config. */
export function parseConfig(raw: string | null | undefined): GuardrailsConfig {
  return safeParseConfig(raw).config;
}
