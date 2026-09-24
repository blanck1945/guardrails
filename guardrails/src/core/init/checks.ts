import { parseCheck } from "../checks/spec";
import type { CandidateRule } from "./synthesize";

export interface CheckWarning {
  id: string;
  check: string;
  error: string;
}

/**
 * Validates the `check:` the model proposed for each candidate. An invalid check is discarded and the rule is
 * kept without it (a warning is returned); a valid one is normalized (trimmed). Pure and deterministic.
 */
export function validateChecks(candidates: readonly CandidateRule[]): { candidates: CandidateRule[]; warnings: CheckWarning[] } {
  const warnings: CheckWarning[] = [];
  const out = candidates.map((c) => {
    if (c.check === undefined) return c;
    const { check, exclude, ...rest } = c;
    const raw = check.trim();
    if (!raw) return rest;
    const parsed = parseCheck(raw);
    if (!parsed.ok) {
      warnings.push({ id: c.id, check: raw, error: parsed.error });
      return rest;
    }
    const ex = (exclude ?? []).map((g) => g.trim()).filter(Boolean);
    return { ...rest, check: raw, ...(ex.length ? { exclude: ex } : {}) };
  });
  return { candidates: out, warnings };
}
