import picomatch from "picomatch";
import { globMatchesFile } from "../rules/select";
import type { CandidateRule } from "./synthesize";

/** Confidence multiplier for a rule none of whose scopes exist in the repo. */
export const NO_SCOPE_CONFIDENCE_FACTOR = 0.5;

export interface ScopeWarning {
  id: string;
  /** Scope globs that matched no tracked file and could not be repaired (removed). */
  dropped: string[];
  /** Scope globs repaired to the single tracked file they were a prefix of. */
  repaired: { from: string; to: string }[];
  /** No scope survived: the rule falls back to `**` with lower confidence. */
  noValidScope: boolean;
}

export interface ScopeValidation {
  candidates: CandidateRule[];
  scopeWarnings: ScopeWarning[];
}

const isPlainPath = (g: string) => !picomatch.scan(g).isGlob;

/** Replaces `from` by `to` in text where `from` is not followed by a path character (avoids touching longer names). */
function repairMentions(text: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\w./-])${esc}(?![\\w/-])`, "g"), to);
}

/**
 * Deterministic check of each candidate scope against the repo's tracked files.
 *  - a glob that matches at least one file is kept untouched;
 *  - a plain path that matches nothing is repaired when it is a prefix of exactly ONE tracked file
 *    (`seeds.config.` -> `seeds.config.json`); the same fix is applied to mentions of it in the rule text;
 *  - anything else is dropped;
 *  - a rule left without scope gets `**`, its confidence is lowered and it is reported.
 * Rules that had no problem are returned as the same objects.
 */
export function validateScopes(candidates: readonly CandidateRule[], trackedFiles: readonly string[]): ScopeValidation {
  const scopeWarnings: ScopeWarning[] = [];
  if (!trackedFiles.length) return { candidates: [...candidates], scopeWarnings };
  const files = trackedFiles.map((f) => f.replaceAll("\\", "/"));

  const out = candidates.map((c) => {
    const kept: string[] = [];
    const dropped: string[] = [];
    const repaired: ScopeWarning["repaired"] = [];
    for (const glob of c.scope) {
      if (glob === "**" || files.some((f) => globMatchesFile(glob, f))) {
        kept.push(glob);
        continue;
      }
      const g = glob.trim().replace(/^\.\//, "");
      const prefixed = isPlainPath(g) ? files.filter((f) => f.startsWith(g)) : [];
      if (prefixed.length === 1) {
        kept.push(prefixed[0]!);
        repaired.push({ from: glob, to: prefixed[0]! });
      } else dropped.push(glob);
    }
    if (!dropped.length && !repaired.length) return c;

    let rule = c.rule;
    for (const r of repaired) rule = repairMentions(rule, r.from, r.to);
    const uniq = [...new Set(kept)];
    const noValidScope = uniq.length === 0;
    scopeWarnings.push({ id: c.id, dropped, repaired, noValidScope });
    return {
      ...c,
      rule,
      scope: noValidScope ? ["**"] : uniq,
      confidence: noValidScope ? c.confidence * NO_SCOPE_CONFIDENCE_FACTOR : c.confidence,
    };
  });
  return { candidates: out, scopeWarnings };
}
