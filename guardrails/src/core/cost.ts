import { estimateCostUsd, priceFor, type PricedUsage } from "./pricing";

export interface CostSnapshot {
  /** USD spent on models with a known price. */
  costUsd: number;
  /** False when some tokens were spent on a model without a known price. */
  complete: boolean;
  totalTokens: number;
  unpricedTokens: number;
  unpricedModels: string[];
  calls: number;
  /** Calls answered from the LLM cache (no model call, no spend). */
  cachedCalls: number;
}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly snapshot: CostSnapshot,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export interface CostTrackerOptions {
  /** Stop once spend reaches this many USD. */
  maxUsd?: number;
  /** Token cap (input + output). Used when a model has no known price. */
  maxTokens?: number;
  /** Called once per warning (e.g. unpriced model). Warnings are also kept in `warnings`. */
  onWarn?: (message: string) => void;
}

/** Assumed blended price used to derive a token cap from `maxUsd` for unpriced models. */
export const FALLBACK_USD_PER_MTOK = 1;

/** Accumulates usage -> USD per model call and enforces a spend cap. */
export class CostTracker {
  readonly warnings: string[] = [];
  private costUsd = 0;
  private totalTokens = 0;
  private unpricedTokens = 0;
  private readonly unpriced = new Set<string>();
  private calls = 0;
  private cachedCalls = 0;

  constructor(readonly options: CostTrackerOptions = {}) {}

  snapshot(): CostSnapshot {
    return {
      costUsd: this.costUsd,
      complete: this.unpricedTokens === 0,
      totalTokens: this.totalTokens,
      unpricedTokens: this.unpricedTokens,
      unpricedModels: [...this.unpriced],
      calls: this.calls,
      cachedCalls: this.cachedCalls,
    };
  }

  /** Effective token cap: explicit, or derived from `maxUsd` once an unpriced model was seen. */
  private tokenCap(): number | undefined {
    if (this.options.maxTokens !== undefined) return this.options.maxTokens;
    if (this.unpriced.size && this.options.maxUsd !== undefined) {
      return Math.round((this.options.maxUsd / FALLBACK_USD_PER_MTOK) * 1_000_000);
    }
    return undefined;
  }

  private exceededReason(): string | null {
    const { maxUsd } = this.options;
    if (maxUsd !== undefined && this.costUsd >= maxUsd) {
      return `spend limit reached: $${this.costUsd.toFixed(4)} of $${maxUsd}`;
    }
    const cap = this.tokenCap();
    if (cap !== undefined && this.totalTokens >= cap) {
      return `token limit reached: ${this.totalTokens} of ${cap} tokens`;
    }
    return null;
  }

  private warn(message: string): void {
    this.warnings.push(message);
    this.options.onWarn?.(message);
  }

  /** Call before a real model call: refuses to start once the cap has been reached. */
  assertWithinBudget(): void {
    const reason = this.exceededReason();
    if (reason) throw new BudgetExceededError(`Budget exceeded (${reason})`, this.snapshot());
  }

  /** Adds one model call. Throws `BudgetExceededError` when it takes the total to the cap. */
  record(modelSpec: string, usage: PricedUsage): void {
    this.calls += 1;
    const tokens = usage.inputTokens + usage.outputTokens;
    this.totalTokens += tokens;
    const usd = priceFor(modelSpec) ? estimateCostUsd(modelSpec, usage) : null;
    if (usd === null) {
      this.unpricedTokens += tokens;
      if (!this.unpriced.has(modelSpec)) {
        this.unpriced.add(modelSpec);
        const cap = this.tokenCap();
        this.warn(
          `No known price for model "${modelSpec}": cost is not estimated and the limit is applied on tokens` +
            (cap !== undefined ? ` (${cap} tokens)` : " (set maxTokens)") +
            ".",
        );
      }
    } else {
      this.costUsd += usd;
    }
    this.assertWithinBudget();
  }

  recordCached(): void {
    this.cachedCalls += 1;
  }
}

/** Cost of the work done since `before` was taken; `null` if any of it was on an unpriced model. */
export function costSince(tracker: CostTracker, before: CostSnapshot): number | null {
  const now = tracker.snapshot();
  if (now.unpricedTokens > before.unpricedTokens) return null;
  return now.costUsd - before.costUsd;
}
