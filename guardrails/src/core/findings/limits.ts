export interface LimitableFinding {
  file: string;
  line: number;
  severity: "low" | "medium" | "high";
  confidence: number;
  ruleId?: string | undefined;
}

export interface LimitRule {
  id: string;
  severity: "low" | "medium" | "high";
  status: string;
}

const SEV_WEIGHT = { low: 1, medium: 2, high: 3 } as const;

/** Max findings per review by strictness (1 = quiet, 3 = thorough). */
export const FINDING_CAPS = { 1: 3, 2: 5, 3: 8 } as const;
/** Max findings that may share one (file, line). */
export const MAX_PER_LOCATION = 2;

export const capFor = (strictness: number): number => FINDING_CAPS[strictness as 1 | 2 | 3] ?? FINDING_CAPS[2];

/** severity x confidence, the ordering used to decide what survives. */
export const findingScore = (f: Pick<LimitableFinding, "severity" | "confidence">): number => SEV_WEIGHT[f.severity] * f.confidence;

export interface LimitResult<T> {
  kept: T[];
  dropped: { finding: T; reason: "duplicate" | "over-cap" }[];
}

const activeIdSet = (rules: readonly LimitRule[]) => new Set(rules.filter((r) => r.status === "active").map((r) => r.id));

/**
 * Collapses findings that pile up on one spot:
 *  1. same (file, line) and same rule -> only the best one stays (a rule-less pair is not merged here);
 *  2. at most `MAX_PER_LOCATION` per (file, line); a finding that cites an active rule outranks a generic one,
 *     then higher severity x confidence wins.
 * Kept findings preserve their input order.
 */
export function collapseByLocation<T extends LimitableFinding>(findings: readonly T[], rules: readonly LimitRule[]): LimitResult<T> {
  const active = activeIdSet(rules);
  const cites = (f: T) => !!f.ruleId && active.has(f.ruleId);
  const rank = (a: T, b: T) => Number(cites(b)) - Number(cites(a)) || findingScore(b) - findingScore(a);
  const dropped: LimitResult<T>["dropped"] = [];

  const groups = new Map<string, T[]>();
  for (const f of findings) {
    const k = `${f.file}\0${f.line}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  const survivors = new Set<T>();
  for (const group of groups.values()) {
    const bestByRule = new Map<string, T>();
    const rest: T[] = [];
    for (const f of group) {
      if (!f.ruleId) {
        rest.push(f);
        continue;
      }
      const prev = bestByRule.get(f.ruleId);
      if (!prev) bestByRule.set(f.ruleId, f);
      else if (rank(f, prev) < 0) {
        dropped.push({ finding: prev, reason: "duplicate" });
        bestByRule.set(f.ruleId, f);
      } else dropped.push({ finding: f, reason: "duplicate" });
    }
    const ranked = [...bestByRule.values(), ...rest].sort(rank);
    for (const [i, f] of ranked.entries()) {
      if (i < MAX_PER_LOCATION) survivors.add(f);
      else dropped.push({ finding: f, reason: "duplicate" });
    }
  }
  return { kept: findings.filter((f) => survivors.has(f)), dropped };
}

/**
 * Keeps at most `cap` findings, best `severity x confidence` first. A finding that cites an `active`
 * rule of severity `high` is never dropped (it may push the total above the cap). Kept findings preserve input order.
 */
export function capFindings<T extends LimitableFinding>(findings: readonly T[], rules: readonly LimitRule[], cap: number): LimitResult<T> {
  const protectedIds = new Set(rules.filter((r) => r.status === "active" && r.severity === "high").map((r) => r.id));
  const isProtected = (f: T) => !!f.ruleId && protectedIds.has(f.ruleId);
  const ranked = [...findings].sort((a, b) => Number(isProtected(b)) - Number(isProtected(a)) || findingScore(b) - findingScore(a));
  const keep = new Set<T>();
  for (const f of ranked) if (isProtected(f) || keep.size < cap) keep.add(f);
  const dropped = ranked.filter((f) => !keep.has(f)).map((finding) => ({ finding, reason: "over-cap" as const }));
  return { kept: findings.filter((f) => keep.has(f)), dropped };
}
