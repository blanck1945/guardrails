import type { RuleChecksMode } from "./agent/prompts";
import type { GuardrailsConfig } from "./config";
import { parseUnifiedDiff } from "./diff";
import { messages, type Language } from "./i18n";
import { globMatchesFile } from "./rules/select";

export const MODE_NAMES = ["basic", "standard", "deep"] as const;
export type ModeName = (typeof MODE_NAMES)[number];

/** Strictest wins when several signals name different modes. */
const STRICTNESS_RANK: Record<ModeName, number> = { basic: 0, standard: 1, deep: 2 };

export interface ModePreset {
  name: ModeName;
  /** Max agent steps per pass. */
  maxSteps: number;
  /** Max accumulated input tokens per pass. */
  maxInputTokens: number;
  /** Spend cap for the whole review (all passes), USD. */
  budgetUsd: number;
  /** Minimum confidence of a model finding to be kept (strictness 1/2/3 = 0.8/0.6/0.4). `null` = derive from `config.strictness`. */
  minConfidence: number | null;
  /** Max model findings published (mechanical check findings are never capped). `null` = derive from `config.strictness`. */
  findingCap: number | null;
  /** Prompt strictness (1 quiet, 2 default, 3 thorough). `null` = `config.strictness`. */
  strictness: 1 | 2 | 3 | null;
  /** `off`: no per-rule verdicts; `ask`: asked in the prompt; `require`: incomplete reports are bounced once. */
  ruleChecks: RuleChecksMode;
  /** Independent agent passes run concurrently and merged (union, dedupe, confidence boost for findings seen in both). */
  passes: 1 | 2;
  /** Preferred sampling temperature (`GUARDRAILS_TEMPERATURE` overrides it). */
  temperature: number;
  /** Wall-clock deadline for the whole review, seconds (the webhook's own limit is 300). */
  timeoutSec: number;
}

export const MODE_PRESETS: Record<ModeName, ModePreset> = {
  basic: { name: "basic", maxSteps: 4, maxInputTokens: 150_000, budgetUsd: 0.05, minConfidence: 0.8, findingCap: 3, strictness: 1, ruleChecks: "off", passes: 1, temperature: 0, timeoutSec: 120 },
  standard: { name: "standard", maxSteps: 12, maxInputTokens: 350_000, budgetUsd: 0.25, minConfidence: null, findingCap: null, strictness: null, ruleChecks: "ask", passes: 1, temperature: 0, timeoutSec: 240 },
  deep: { name: "deep", maxSteps: 24, maxInputTokens: 600_000, budgetUsd: 0.75, minConfidence: 0.4, findingCap: 12, strictness: 3, ruleChecks: "require", passes: 2, temperature: 0, timeoutSec: 240 },
};

export const isModeName = (v: unknown): v is ModeName => typeof v === "string" && (MODE_NAMES as readonly string[]).includes(v);

export function strictest(modes: readonly ModeName[]): ModeName | undefined {
  return [...modes].sort((a, b) => STRICTNESS_RANK[b] - STRICTNESS_RANK[a])[0];
}

export type ModeSource = "cli" | "label" | "description" | "auto-mode" | "config-default" | "default";

export interface ModeSelection {
  mode: ModeName;
  source: ModeSource;
  /** Human-readable reason, e.g. "label guardrails:deep". */
  detail: string;
}

export interface ChangeStats {
  /** Reviewable changed files (repo-relative). */
  files: readonly string[];
  /** Added plus removed lines. */
  linesChanged: number;
}

/** File list and added+removed line count of a unified diff. */
export function statsOfDiff(diff: string): ChangeStats {
  const parsed = parseUnifiedDiff(diff);
  let linesChanged = 0;
  for (const f of parsed) for (const h of f.hunks) for (const l of h.lines) if (l.type !== "context") linesChanged++;
  return { files: parsed.map((f) => f.path), linesChanged };
}

const LABEL_RE = /^guardrails:(basic|standard|deep)$/i;
const DESCRIPTION_RE = /^[ \t]*guardrails-mode:[ \t]*(basic|standard|deep)[ \t]*$/gim;

/** Modes named by PR labels `guardrails:<mode>` (case-insensitive). Other labels are ignored. */
export function modesFromLabels(labels: readonly string[]): ModeName[] {
  return labels.flatMap((l) => {
    const m = LABEL_RE.exec(l.trim());
    return m ? [m[1]!.toLowerCase() as ModeName] : [];
  });
}

/** Modes named by `guardrails-mode: <mode>` lines in the PR description. */
export function modesFromDescription(description: string | null | undefined): ModeName[] {
  return [...(description ?? "").matchAll(DESCRIPTION_RE)].map((m) => m[1]!.toLowerCase() as ModeName);
}

export type AutoModeRule = NonNullable<GuardrailsConfig["autoMode"]>[number];

/** Do all the conditions of one autoMode entry hold? (Entries have at least one condition.) */
export function autoRuleMatches(rule: AutoModeRule, stats: ChangeStats): boolean {
  const { files, linesChanged } = stats;
  if (rule.filesGreaterThan !== undefined && !(files.length > rule.filesGreaterThan)) return false;
  if (rule.filesLessThan !== undefined && !(files.length < rule.filesLessThan)) return false;
  if (rule.linesChangedGreaterThan !== undefined && !(linesChanged > rule.linesChangedGreaterThan)) return false;
  if (rule.onlyPaths && !(files.length > 0 && files.every((f) => rule.onlyPaths!.some((g) => globMatchesFile(g, f))))) return false;
  if (rule.touchesPaths && !files.some((f) => rule.touchesPaths!.some((g) => globMatchesFile(g, f)))) return false;
  return true;
}

export interface SelectModeInput {
  /** `guardrails review --mode <mode>`. */
  cli?: ModeName | undefined;
  labels?: readonly string[];
  description?: string | null | undefined;
  config: Pick<GuardrailsConfig, "mode" | "autoMode" | "prOverride">;
  stats: ChangeStats;
}

/**
 * Picks the review mode, highest priority first: CLI flag, PR label, PR description line, `autoMode` in
 * `.guardrails/config.json` (first matching entry), `mode` in the config, `standard`.
 * With `prOverride: "none"` neither labels nor the description can change the mode.
 */
export function selectMode(input: SelectModeInput): ModeSelection {
  if (input.cli) return { mode: input.cli, source: "cli", detail: `--mode ${input.cli}` };
  const { config, stats } = input;
  if (config.prOverride !== "none") {
    const byLabel = strictest(modesFromLabels(input.labels ?? []));
    if (byLabel) return { mode: byLabel, source: "label", detail: `label guardrails:${byLabel}` };
    const byText = strictest(modesFromDescription(input.description));
    if (byText) return { mode: byText, source: "description", detail: `description line guardrails-mode: ${byText}` };
  }
  const idx = (config.autoMode ?? []).findIndex((r) => autoRuleMatches(r, stats));
  if (idx >= 0) {
    const rule = config.autoMode![idx]!;
    return { mode: rule.mode, source: "auto-mode", detail: `autoMode rule #${idx + 1} (${stats.files.length} file(s), ${stats.linesChanged} line(s) changed)` };
  }
  if (config.mode) return { mode: config.mode, source: "config-default", detail: "config.json default" };
  return { mode: "standard", source: "default", detail: "default" };
}

/** "Review mode: deep (label guardrails:deep)." */
export function describeMode(sel: Pick<ModeSelection, "mode" | "detail">, lang?: Language): string {
  return messages(lang).summary.describeMode(sel.mode, sel.detail);
}
