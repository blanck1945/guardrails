import type { Rule } from "../config";
import { ruleType } from "./merge";

/**
 * Renders rules for the review prompts (single and agent). Only `active` rules are listed.
 * Each rule carries id, severity, scope, source and its full natural-language body.
 */
export function formatRulesForPrompt(rules: readonly Rule[], mechanical: ReadonlySet<string> = new Set()): string {
  return rules
    .filter((r) => r.status === "active" && !mechanical.has(r.id))
    .map((r) => {
      const meta = [r.severity, `type: ${ruleType(r)}`, `scope: ${r.scope.join(", ")}`, r.exclude?.length && `exclude: ${r.exclude.join(", ")}`, r.source && `source: ${r.source}`].filter(Boolean);
      const body = r.rule
        .trim()
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      return `- [${r.id}] (${meta.join("; ")})\n${body}`;
    })
    .join("\n");
}

/** Prompt line for rules whose `check:` already ran; empty when none did. */
export function formatMechanicalNote(rules: readonly Rule[], mechanical: ReadonlySet<string>): string {
  const ids = rules.filter((r) => r.status === "active" && mechanical.has(r.id)).map((r) => r.id);
  return ids.length
    ? `Rules already verified mechanically (do NOT check or report them again; any violation is reported by another system): ${ids.join(", ")}.`
    : "";
}
