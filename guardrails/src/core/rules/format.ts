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

/** A rule whose check only catches a subset of violations, with the locations it already reported. */
export interface PartialNote {
  ruleId: string;
  locations: readonly { file: string; line: number }[];
}

const MAX_LISTED_LOCATIONS = 12;
const NL = String.fromCharCode(10);

/**
 * Prompt text for rules whose `check:` already ran; empty when none did. Exhaustive checks (`mechanical`) fully decide
 * the rule, so the model skips it. Partial checks (`partial`) only catch a subset: the model still reviews the rule
 * and only skips the locations already reported.
 */
export function formatMechanicalNote(rules: readonly Rule[], mechanical: ReadonlySet<string>, partial: readonly PartialNote[] = []): string {
  const ids = rules.filter((r) => r.status === "active" && mechanical.has(r.id)).map((r) => r.id);
  const exhaustive = ids.length
    ? `Rules already verified mechanically (do NOT check or report them again; any violation is reported by another system): ${ids.join(", ")}.`
    : "";
  const active = new Set(rules.filter((r) => r.status === "active").map((r) => r.id));
  const lines = partial
    .filter((p) => active.has(p.ruleId))
    .map((p) => {
      const shown = p.locations.slice(0, MAX_LISTED_LOCATIONS).map((l) => `${l.file}:${l.line}`);
      const more = p.locations.length > shown.length ? ` and ${p.locations.length - shown.length} more` : "";
      return `- [${p.ruleId}]: ${shown.length ? `already reported at ${shown.join(", ")}${more}` : "the check found nothing"}`;
    });
  const partialNote = lines.length
    ? `Rules with a partial mechanical check. The check only catches a subset of violations, so you MUST still review these rules. Do not repeat the locations it already reported, but do look for violations of the rule that the check cannot see:${NL}${lines.join(NL)}`
    : "";
  return [exhaustive, partialNote].filter(Boolean).join(NL + NL);
}
