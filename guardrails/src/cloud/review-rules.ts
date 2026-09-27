import { loadRules, messages, selectRulesForFiles, type Language, type LoadedRules, type Rule } from "@/core";

export const CONFIG_PATH = ".guardrails/config.json";
export const RULES_PATH = ".guardrails/rules.md";

export type ReadAtRef = (path: string, ref: string) => Promise<string | null>;

/**
 * Loads config + rules from the PR's BASE commit, never from the head. A PR must not be able to
 * weaken its own review by editing `.guardrails/*`. Missing files fall back to defaults.
 */
export async function loadReviewRules(read: ReadAtRef, baseSha: string): Promise<LoadedRules> {
  const [configJson, rulesMd] = await Promise.all([read(CONFIG_PATH, baseSha), read(RULES_PATH, baseSha)]);
  return loadRules(configJson, rulesMd);
}

/** Active rules whose scope matches a changed file: the only ones that reach the prompt. */
export function rulesForPr(loaded: LoadedRules, changedFiles: readonly string[]): Rule[] {
  return selectRulesForFiles(loaded.rules, changedFiles);
}

/** Informative note when the PR edits the rules themselves (those edits only apply after merge). */
export function rulesChangeNote(changedFiles: readonly string[], lang?: Language): string | null {
  const touched = changedFiles.filter((f) => f === RULES_PATH || f === CONFIG_PATH);
  if (!touched.length) return null;
  return messages(lang).cloud.rulesChangeNote(touched.map((f) => `\`${f}\``).join(", "));
}

/** "Rule `english-only` (CLAUDE.md)" line appended to a finding that cites a rule. */
export function ruleCitation(ruleId: string | undefined, rules: readonly Rule[], lang?: Language): string | null {
  if (!ruleId) return null;
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return null;
  return messages(lang).citation(rule.id, rule.source);
}
