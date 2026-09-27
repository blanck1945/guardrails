import type { FileDiff } from "../diff";
import { ALSO_AT, withAlsoAt } from "./dedupe";
import type { Language } from "../i18n";
import type { Finding } from "../types";

const BACKSLASH = String.fromCharCode(92);

/** Same path in every form a finding may carry it (separators, leading `./`). */
export function normalizeFindingPath(p: string): string {
  return p.split(BACKSLASH).join("/").replace(/^\.\//, "");
}

/** Key of a rule in a file, used to pair a model finding with a check finding. */
export function ruleFileKey(f: Pick<Finding, "file" | "ruleId">): string {
  return `${normalizeFindingPath(f.file)}\0${f.ruleId ?? ""}`;
}

/**
 * v0.8.1: model findings that repeat a check finding of a partial rule (same file and rule, whatever the
 * distance) are folded into the closest check finding of that rule and file as "Also at line N". The extra
 * line comes from the model, so it is listed only if it is an added line of that file in the diff. The check
 * finding keeps its severity, confidence, origin and anchor; only its body gains the note (never twice).
 * Pure: the inputs are not modified.
 */
export function mergeModelIntoChecks(
  checks: readonly Finding[],
  models: readonly Finding[],
  diffFiles: readonly FileDiff[],
  lang?: Language,
): Finding[] {
  const extra = new Map<number, Set<number>>();
  for (const m of models) {
    if (!m.ruleId) continue;
    const key = ruleFileKey(m);
    let best = -1;
    let bestDistance = Infinity;
    checks.forEach((c, i) => {
      if (ruleFileKey(c) !== key) return;
      const d = Math.abs(c.line - m.line);
      if (d < bestDistance) {
        best = i;
        bestDistance = d;
      }
    });
    if (best < 0) continue;
    const set = extra.get(best) ?? new Set<number>();
    extra.set(best, set);
    const added = diffFiles.find((d) => normalizeFindingPath(d.path) === normalizeFindingPath(m.file))?.addedLines;
    if (m.line !== checks[best]!.line && added?.includes(m.line)) set.add(m.line);
  }
  return checks.map((c, i) => {
    const lines = [...(extra.get(i) ?? [])].sort((a, b) => a - b);
    if (!lines.length || ALSO_AT.test(c.body)) return c;
    return { ...c, body: withAlsoAt(c.body, lines, lang) };
  });
}
