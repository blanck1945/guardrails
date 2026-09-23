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
