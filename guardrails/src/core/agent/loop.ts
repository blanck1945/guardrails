import { generateText, isStepCount, type LanguageModel, type StepResult, type ToolSet } from "ai";
import type { GuardrailsConfig } from "../config";
import type { CostTracker } from "../cost";
import { resolveModel } from "../models";
import { samplingFor } from "../sampling";
import { findingSchemaV2, type FindingV2, type RuleCheck } from "../findings";
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
import { buildAgentInstructions, buildAgentPrompt, WRAP_UP_MESSAGE, type AgentFocus, type RuleChecksMode } from "./prompts";
import type { PartialNote } from "../rules/format";
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
  /** Rules whose check is partial: still reviewed by the model, told which locations the check already reported. */
  partialChecks?: readonly PartialNote[] | undefined;
  /** Temperature preferred by the review mode (`GUARDRAILS_TEMPERATURE` overrides it). */
  temperature?: number | undefined;
  /** `require`: a report that omits verdicts for rules in scope is bounced once (deep mode). Default `ask`. */
  ruleChecks?: RuleChecksMode | undefined;
  /** Second-pass focus (deep mode runs two passes). */
  focus?: AgentFocus | undefined;
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
  /** Verdicts from the exhaustive per-rule pass, when the model gave them. */
  ruleChecks?: RuleCheck[] | undefined;
  /** Distinct paths the agent read at the head revision (`read_file`, ref `head` or omitted, no error), sorted. */
  filesOpened: string[];
}

type AnyStep = StepResult<ToolSet, any>;

function invalidReportCalls(steps: readonly AnyStep[]): { toolName: string; input: unknown }[] {
  return steps
    .flatMap((s) => s.content)
    .filter((p) => p.type === "tool-error" && p.toolName === REPORT_TOOL)
    .map((p) => ({ toolName: REPORT_TOOL, input: (p as { input?: unknown }).input }));
}

/** Paths successfully read at the head revision through `read_file`, deduplicated and sorted. */
export function headFilesOpened(steps: readonly AnyStep[]): string[] {
  const opened = new Set<string>();
  for (const step of steps) {
    const calls = new Map<string, { path?: unknown; ref?: unknown }>();
    for (const p of step.content) {
      if (p.type === "tool-call" && p.toolName === "read_file") calls.set(p.toolCallId, (p.input ?? {}) as { path?: unknown; ref?: unknown });
    }
    for (const p of step.content) {
      if (p.type !== "tool-result" || p.toolName !== "read_file") continue;
      const out = (p as { output?: unknown }).output;
      if (out && typeof out === "object" && "error" in out) continue;
      const input = calls.get(p.toolCallId);
      if (!input || typeof input.path !== "string" || (input.ref !== undefined && input.ref !== "head")) continue;
      opened.add(input.path.replaceAll(String.fromCharCode(92), "/").replace(/^\.\//, ""));
    }
  }
  return [...opened].sort();
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

  const ruleChecksMode = opts.ruleChecks ?? "ask";
  const skip = opts.mechanicalRuleIds ?? new Set<string>();
  const requiredRules = ruleChecksMode === "off" ? [] : opts.config.rules.filter((r) => r.status === "active" && !skip.has(r.id)).map((r) => r.id);
  const missingVerdicts = (r: Report) => requiredRules.filter((id) => !r.ruleChecks?.some((c) => c.ruleId === id));
  let bounced = 0;
  let bouncedReport: Report | undefined;

  const tools = {
    ...createWorkspaceTools(opts.workspace),
    [REPORT_TOOL]: createReportTool(
      (r) => {
        report = r;
      },
      (r) => {
        // Deep mode: one bounce for a report that skips rules in scope; the second report is accepted as it is.
        if (ruleChecksMode !== "require" || bounced >= 1) return undefined;
        const missing = missingVerdicts(r);
        if (!missing.length) return undefined;
        bounced++;
        bouncedReport = r;
        return `Incomplete: ruleChecks has no verdict for rule(s) ${missing.join(", ")}. Add one entry per rule (and per changed file in its scope): violated, ok or not-applicable, and list every location of each violation. Then call report_findings again.`;
      },
    ),
  };

  const diff = opts.input.diff || (await opts.workspace.diff());
  const accumulatedInput = (steps: readonly AnyStep[]) => sumUsage(steps.map((s) => s.usage)).inputTokens;

  const result = await generateText({
    model: resolveModel(opts.model, { tracker: opts.costTracker }),
    instructions: buildAgentInstructions(opts.config, budget, opts.mechanicalRuleIds, { ruleChecks: ruleChecksMode, focus: opts.focus, partialChecks: opts.partialChecks }),
    prompt: buildAgentPrompt(opts.input, diff),
    tools,
    // The model must always call a tool; the only way to finish is report_findings.
    toolChoice: "required",
    maxOutputTokens: budget.maxOutputTokens,
    ...samplingFor(opts.model, opts.temperature),
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
  const filesOpened = headFilesOpened(result.steps);

  // A bounced report is better than nothing when the run ended before a second one.
  const finalReport = (report ?? bouncedReport) as Report | undefined;
  if (finalReport) {
    const r = finalReport;
    const incompleteChecks = ruleChecksMode === "require" && missingVerdicts(r).length > 0;
    const notes = incompleteChecks ? [r.notes, "incomplete-rule-checks"].filter(Boolean).join("; ") : r.notes;
    return {
      findings: r.findings,
      notes,
      ruleChecks: r.ruleChecks,
      usage,
      incomplete: false,
      invalidReports: invalid.length,
      forcedWrapUp,
      filesOpened,
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
    filesOpened,
  };
}
