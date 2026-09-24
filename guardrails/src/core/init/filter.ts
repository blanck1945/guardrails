import type { CandidateRule } from "./synthesize";

export const DEFAULT_MIN_CONFIDENCE = 0.6;

export interface FilterOptions {
  /** Candidates below this confidence are dropped (listed separately). Default 0.6. */
  minConfidence?: number;
  /** Keep `tool-enforced` candidates instead of listing them aside. Default false. */
  includeToolEnforced?: boolean;
}

export interface FilteredCandidates {
  kept: CandidateRule[];
  /** Already enforced by a linter, type checker or CI: redundant as review rules. */
  toolEnforced: CandidateRule[];
  lowConfidence: CandidateRule[];
}

export function filterCandidates(
  candidates: readonly CandidateRule[],
  { minConfidence = DEFAULT_MIN_CONFIDENCE, includeToolEnforced = false }: FilterOptions = {},
): FilteredCandidates {
  const out: FilteredCandidates = { kept: [], toolEnforced: [], lowConfidence: [] };
  for (const c of candidates) {
    if (c.kind === "tool-enforced" && !includeToolEnforced) out.toolEnforced.push(c);
    else if (c.confidence < minConfidence) out.lowConfidence.push(c);
    else out.kept.push(c);
  }
  return out;
}
