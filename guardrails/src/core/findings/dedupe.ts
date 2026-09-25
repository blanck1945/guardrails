import type { FindingV2 } from "./schema";
import { normalizeTitle } from "./fingerprint";

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 } as const;

export interface DedupeOptions {
  /** Max distance between `line`s to be considered the same spot. */
  lineWindow?: number;
  /** Minimum Jaccard similarity of title tokens. */
  minSimilarity?: number;
}

function tokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(" ").filter(Boolean));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function better(a: FindingV2, b: FindingV2): boolean {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  return s !== 0 ? s > 0 : a.confidence >= b.confidence;
}

function mergeEvidence(a: FindingV2["evidence"], b: FindingV2["evidence"]): FindingV2["evidence"] {
  const seen = new Set<string>();
  const out: FindingV2["evidence"] = [];
  for (const e of [...a, ...b]) {
    const k = `${e.file}:${e.startLine}-${e.endLine}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out.slice(0, 5);
}

/**
 * Merges findings of the same problem: same file, lines within ±3 and title Jaccard >= 0.5.
 * Keeps the higher-severity one (ties: higher confidence) and unions the evidence.
 * (F2 replaces title Jaccard with embeddings.) Output order follows first appearance.
 */
export function dedupe<T extends FindingV2>(findings: T[], opts: DedupeOptions = {}): T[] {
  const { lineWindow = 3, minSimilarity = 0.5 } = opts;
  const kept: { f: T; tok: Set<string> }[] = [];
  for (const f of findings) {
    const tok = tokens(f.title);
    const hit = kept.find(
      (k) =>
        k.f.file === f.file &&
        Math.abs(k.f.line - f.line) <= lineWindow &&
        jaccard(k.tok, tok) >= minSimilarity,
    );
    if (!hit) {
      kept.push({ f, tok });
      continue;
    }
    const evidence = mergeEvidence(hit.f.evidence, f.evidence);
    if (better(f, hit.f)) {
      hit.f = { ...f, evidence };
      hit.tok = tok;
    } else {
      hit.f = { ...hit.f, evidence };
    }
  }
  return kept.map((k) => k.f);
}

export const BOTH_PASSES_BOOST = 0.1;
const ALSO_AT = /\bAlso at lines? \d/;

/** Same problem seen by two different passes: by meaning (rule or title), not by line distance alone. */
function sameProblem(a: FindingV2, b: FindingV2, minSimilarity: number, lineWindow: number): boolean {
  if (a.file !== b.file) return false;
  if (a.ruleId && a.ruleId === b.ruleId) return true;
  const similar = jaccard(tokens(a.title), tokens(b.title)) >= minSimilarity;
  if (!a.ruleId && !b.ruleId) return similar;
  return similar && Math.abs(a.line - b.line) <= lineWindow;
}

export interface CrossPassMerge<T> {
  findings: T[];
  /** How many findings were folded into another one. */
  merged: number;
}

/**
 * Unions the findings of independent passes so that one problem yields one finding. Two findings of different
 * passes are the same problem when they share the file and the rule (or, without a rule, a similar title),
 * whatever the distance between their lines. Matching is one to one: two different problems under one rule
 * that both passes report stay two, and findings of the same pass are never merged with each other.
 * The merged finding keeps the higher severity (ties: higher confidence), gains +0.1 confidence for having been
 * seen twice, unites the evidence and lists the other locations in its body ("Also at lines 25, 31.").
 */
export function mergeAcrossPasses<T extends FindingV2>(
  passes: readonly (readonly T[])[],
  opts: DedupeOptions = {},
): CrossPassMerge<T> {
  const { lineWindow = 3, minSimilarity = 0.5 } = opts;
  const out: { f: T; seen: Set<number>; also: Set<number> }[] = [];
  let merged = 0;
  passes.forEach((list, pass) => {
    for (const f of list) {
      let best: (typeof out)[number] | undefined;
      let bestScore = -Infinity;
      for (const o of out) {
        if (o.seen.has(pass) || !sameProblem(o.f, f, minSimilarity, lineWindow)) continue;
        const score = jaccard(tokens(o.f.title), tokens(f.title)) - Math.abs(o.f.line - f.line) / 1000;
        if (score > bestScore) {
          best = o;
          bestScore = score;
        }
      }
      if (!best) {
        out.push({ f, seen: new Set([pass]), also: new Set() });
        continue;
      }
      merged++;
      const wins = better(f, best.f) && !better(best.f, f);
      const keep = wins ? f : best.f;
      const other = wins ? best.f : f;
      const ruleId = keep.ruleId ?? other.ruleId;
      const firstMerge = best.seen.size === 1;
      best.also.add(other.line);
      best.also.add(best.f.line);
      best.also.add(f.line);
      best.f = {
        ...keep,
        evidence: mergeEvidence(best.f.evidence, f.evidence),
        ...(ruleId ? { ruleId } : {}),
        confidence: firstMerge ? Math.min(1, +(keep.confidence + BOTH_PASSES_BOOST).toFixed(2)) : keep.confidence,
      };
      best.seen.add(pass);
    }
  });
  const findings = out.map((o) => {
    const lines = [...o.also].filter((l) => l !== o.f.line).sort((a, b) => a - b);
    if (!lines.length || ALSO_AT.test(o.f.body)) return o.f;
    const note = `Also at line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}.`;
    return { ...o.f, body: `${o.f.body}\n\n${note}` };
  });
  return { findings, merged };
}
