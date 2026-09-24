import picomatch from "picomatch";
import type { Rule } from "../config";

function matchesScope(scope: readonly string[], file: string): boolean {
  const p = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return scope.some((pat) => {
    const g = pat.trim().replace(/^\.\//, "");
    // Same convention as ignore patterns: a glob without "/" (e.g. "*.ts") matches the basename at any depth.
    return g !== "" && picomatch(g, { dot: true, basename: !g.includes("/") })(p);
  });
}

/**
 * Rules that apply to a PR: `active` AND whose scope matches at least one changed file.
 * Pure function so it can be tested without GitHub or a model.
 */
export function selectRulesForFiles(rules: readonly Rule[], changedFiles: readonly string[]): Rule[] {
  return rules.filter((r) => r.status === "active" && changedFiles.some((f) => matchesScope(r.scope, f)));
}

/**
 * A finding that names a `ruleId` must refer to a rule that was given to the model.
 * Findings citing an unknown rule (hallucinated or out of scope) are discarded.
 */
export function dropUnknownRuleFindings<T extends { ruleId?: string | undefined }>(
  findings: readonly T[],
  rules: readonly Rule[],
): T[] {
  const ids = new Set(rules.filter((r) => r.status === "active").map((r) => r.id));
  return findings.filter((f) => !f.ruleId || ids.has(f.ruleId));
}
