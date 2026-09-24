import type { Rule } from "../config";

/**
 * Merges rules from `config.json` and `rules.md`. On a repeated id the md rule wins.
 * Ids listed in `disabledRules` become `disabled` (kept in the list so tools like
 * `init` do not re-suggest them). Order: config rules first, then new md rules.
 */
export function mergeRules(
  configRules: readonly Rule[],
  mdRules: readonly Rule[],
  disabledRules: readonly string[] = [],
): Rule[] {
  const byId = new Map<string, Rule>();
  for (const r of configRules) byId.set(r.id, r);
  for (const r of mdRules) byId.set(r.id, r); // keeps first-insertion order, replaces the value
  const off = new Set(disabledRules);
  return [...byId.values()].map((r) => (off.has(r.id) ? { ...r, status: "disabled" as const } : r));
}

/** Only `active` rules reach the review; `suggested` and `disabled` never do. */
export function activeRules(rules: readonly Rule[]): Rule[] {
  return rules.filter((r) => r.status === "active");
}
