import type { Rule } from "../config";
import { ruleType } from "./merge";

/**
 * Renders rules for the review prompts (single and agent). Only `active` rules are listed.
 * Each rule carries id, severity, scope, source and its full natural-language body.
 */
export function formatRulesForPrompt(rules: readonly Rule[]): string {
  return rules
    .filter((r) => r.status === "active")
    .map((r) => {
      const meta = [r.severity, `type: ${ruleType(r)}`, `scope: ${r.scope.join(", ")}`, r.source && `source: ${r.source}`].filter(Boolean);
      const body = r.rule
        .trim()
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n");
      return `- [${r.id}] (${meta.join("; ")})\n${body}`;
    })
    .join("\n");
}
