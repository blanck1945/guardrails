import type { ModelMessage } from "ai";

/** Budgets from PLAN-DETAILED §3.4 (agent "general"). */
export interface AgentBudget {
  /** Max model steps, including the forced report step. */
  maxSteps: number;
  /** Max accumulated input tokens (cached reads included). */
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Ratio of `maxInputTokens` that triggers the forced wrap-up. */
  wrapUpRatio: number;
  /** Above this many accumulated input tokens, old tool results are elided (once). */
  elideAboveInputTokens: number;
  /** Tool results older than this many steps get elided. */
  elideOlderThanSteps: number;
  /** Retries allowed after an invalid `report_findings` call. */
  maxReportRetries: number;
}

export const GENERAL_BUDGET: AgentBudget = {
  maxSteps: 12,
  maxInputTokens: 350_000,
  maxOutputTokens: 8_000,
  wrapUpRatio: 0.8,
  elideAboveInputTokens: 80_000,
  elideOlderThanSteps: 4,
  maxReportRetries: 2,
};

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  steps: number;
}

export const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  steps: 0,
});

type UsageLike = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
};

export function sumUsage(items: readonly UsageLike[]): UsageTotals {
  const total = emptyUsage();
  for (const u of items) {
    total.inputTokens += u.inputTokens ?? 0;
    total.cachedInputTokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.steps += 1;
  }
  return total;
}

/**
 * Should the next step be the forced `report_findings` step?
 * `stepNumber` is 0-based, so `maxSteps - 1` is the last step allowed to run.
 */
export function shouldWrapUp(
  budget: AgentBudget,
  stepNumber: number,
  accumulatedInputTokens: number,
): boolean {
  return (
    stepNumber >= budget.maxSteps - 1 ||
    accumulatedInputTokens >= budget.wrapUpRatio * budget.maxInputTokens
  );
}

/**
 * Replaces tool results older than `olderThanSteps` assistant turns with a stub.
 * Meant to be applied a single time so the prompt cache is only broken once.
 */
export function elideOldToolResults(
  messages: ModelMessage[],
  olderThanSteps: number,
): ModelMessage[] {
  // Each assistant message is one step; tool results follow their assistant message.
  const assistantIdx = messages.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  if (assistantIdx.length <= olderThanSteps) return messages;
  const cutoff = assistantIdx[assistantIdx.length - olderThanSteps]!;

  // Remember what each tool call was, to describe it in the stub.
  const callInfo = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type === "tool-call") {
        callInfo.set(part.toolCallId, `${part.toolName} ${JSON.stringify(part.input)}`.slice(0, 160));
      }
    }
  }

  return messages.map((m, i) => {
    if (m.role !== "tool" || i >= cutoff) return m;
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === "tool-result"
          ? {
              ...part,
              output: {
                type: "text" as const,
                value: `[elided: ${callInfo.get(part.toolCallId) ?? part.toolName}]`,
              },
            }
          : part,
      ),
    };
  });
}
