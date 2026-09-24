import { generateText, isStepCount, type LanguageModel, type StepResult, type ToolSet } from "ai";
import type { GuardrailsConfig } from "../config";
import type { CostTracker } from "../cost";
import { resolveModel } from "../models";
import { findingSchemaV2, type FindingV2 } from "../findings";
import type { ReviewInput } from "../types";
import type { Workspace } from "../workspace";
import {
  elideOldToolResults,
  GENERAL_BUDGET,
  shouldWrapUp,
  sumUsage,
  type AgentBudget,
  type UsageTotals,
} from "./budget";
import { buildAgentInstructions, buildAgentPrompt, WRAP_UP_MESSAGE } from "./prompts";
import { createReportTool, createWorkspaceTools, REPORT_TOOL, type Report } from "./tools";

export interface AgentRunOptions {
  model: LanguageModel;
  config: GuardrailsConfig;
  workspace: Workspace;
  input: ReviewInput;
  budget?: Partial<AgentBudget>;
  abortSignal?: AbortSignal;
  costTracker?: CostTracker | undefined;
  /** Rules whose mechanical check already ran: listed to the model as "do not report". */
  mechanicalRuleIds?: ReadonlySet<string> | undefined;
}

export interface AgentRunResult {
  findings: FindingV2[];
  notes?: string | undefined;
  usage: UsageTotals;
  /** True when the model never produced a valid report (budget/retries exhausted). */
  incomplete: boolean;
  /** Number of invalid `report_findings` calls that were bounced back to the model. */
  invalidReports: number;
  /** True when the forced wrap-up step was triggered. */
  forcedWrapUp: boolean;
}

type AnyStep = StepResult<ToolSet, any>;

function invalidReportCalls(steps: readonly AnyStep[]): { toolName: string; input: unknown }[] {
  return steps
    .flatMap((s) => s.content)
    .filter((p) => p.type === "tool-error" && p.toolName === REPORT_TOOL)
    .map((p) => ({ toolName: REPORT_TOOL, input: (p as { input?: unknown }).input }));
}

/** Salvage the valid items of a malformed report (PLAN-DETAILED §3.9). */
function salvage(input: unknown): FindingV2[] {
  const raw = (input as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = findingSchemaV2.safeParse(item);
    return r.success ? [r.data] : [];
  });
}

/**
 * Tool-calling review loop: workspace tools + terminal `report_findings`, with a
 * step/token budget and a forced wrap-up on the last step (PLAN-DETAILED §3.4).
 */
export async function runReviewAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const budget: AgentBudget = { ...GENERAL_BUDGET, ...opts.budget };
  let report: Report | undefined;
  let forcedWrapUp = false;
  let elided = false;

  const tools = {
    ...createWorkspaceTools(opts.workspace),
    [REPORT_TOOL]: createReportTool((r) => {
      report = r;
    }),
  };

  const diff = opts.input.diff || (await opts.workspace.diff());
  const accumulatedInput = (steps: readonly AnyStep[]) => sumUsage(steps.map((s) => s.usage)).inputTokens;

  const result = await generateText({
    model: resolveModel(opts.model, { tracker: opts.costTracker }),
    instructions: buildAgentInstructions(opts.config, budget, opts.mechanicalRuleIds),
    prompt: buildAgentPrompt(opts.input, diff),
    tools,
    // The model must always call a tool; the only way to finish is report_findings.
    toolChoice: "required",
    maxOutputTokens: budget.maxOutputTokens,
    abortSignal: opts.abortSignal,
    stopWhen: [
      () => report !== undefined,
      isStepCount(budget.maxSteps),
      ({ steps }) => invalidReportCalls(steps).length > budget.maxReportRetries,
      ({ steps }) => accumulatedInput(steps) >= budget.maxInputTokens,
    ],
    prepareStep: ({ steps, stepNumber, messages }) => {
      const inputTokens = accumulatedInput(steps);
      let nextMessages = messages;

      if (!elided && inputTokens > budget.elideAboveInputTokens) {
        elided = true;
        nextMessages = elideOldToolResults(nextMessages, budget.elideOlderThanSteps);
      }

      if (shouldWrapUp(budget, stepNumber, inputTokens)) {
        forcedWrapUp = true;
        return {
          toolChoice: { type: "tool", toolName: REPORT_TOOL },
          activeTools: [REPORT_TOOL],
          messages: [...nextMessages, { role: "user", content: WRAP_UP_MESSAGE }],
        };
      }
      return nextMessages === messages ? undefined : { messages: nextMessages };
    },
  });

  const usage = sumUsage(result.steps.map((s) => s.usage));
  const invalid = invalidReportCalls(result.steps);

  if (report) {
    const r = report as Report;
    return {
      findings: r.findings,
      notes: r.notes,
      usage,
      incomplete: false,
      invalidReports: invalid.length,
      forcedWrapUp,
    };
  }

  // No valid report: keep whatever valid items the last malformed report contained.
  const last = invalid[invalid.length - 1];
  return {
    findings: last ? salvage(last.input) : [],
    usage,
    incomplete: true,
    invalidReports: invalid.length,
    forcedWrapUp,
  };
}
