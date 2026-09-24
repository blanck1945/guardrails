import picomatch from "picomatch";
import type { Rule } from "../config";

/** Does one scope glob match a repo-relative file? A glob without "/" (e.g. "*.ts") matches the basename at any depth. */
export function globMatchesFile(glob: string, file: string): boolean {
  const p = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const g = glob.trim().replace(/^\.\//, "");
  return g !== "" && picomatch(g, { dot: true, basename: !g.includes("/") })(p);
}

function matchesScope(scope: readonly string[], file: string): boolean {
  return scope.some((pat) => globMatchesFile(pat, file));
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
 * An unknown id (hallucinated, out of scope, or not active) is stripped and the finding is kept:
 * the problem it describes can still be real, it just is not attributed to a rule.
 */
export function stripUnknownRuleIds<T extends { ruleId?: string | undefined }>(
  findings: readonly T[],
  rules: readonly Rule[],
): T[] {
  const ids = new Set(rules.filter((r) => r.status === "active").map((r) => r.id));
  return findings.map((f) => {
    if (!f.ruleId || ids.has(f.ruleId)) return f;
    const { ruleId: _unknown, ...rest } = f;
    return rest as T;
  });
}
