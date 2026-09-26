import type { ModeSelection } from "./modes";

export interface SummaryInput {
  /** Review mode and why it was chosen (absent when the caller did not select one). */
  selection?: Pick<ModeSelection, "mode" | "detail"> | undefined;
  /** Findings that are published (inline or in the summary). */
  total: number;
  fromChecks: number;
  fromModel: number;
  /** Duplicates folded into another finding across deep passes. */
  merged?: number;
  /** Lower-priority findings left out because of the review cap. */
  omitted?: number;
  /** The model's free notes (agent) or summary (single); only the first lines are shown. */
  notes?: string | undefined;
  /** The agent never produced a valid report. */
  incomplete?: boolean | undefined;
  modelIncomplete?: "budget" | "timeout" | "error" | undefined;
  passes?: number | undefined;
  passesFailed?: number | undefined;
  /** The visible coverage line (see `formatCoverageLine`); goes after the counts, before the notes. */
  coverageLine?: string | undefined;
  /** The collapsed details block (see `formatCoverageDetails`); goes last. */
  coverageDetails?: string | undefined;
}

const FAILURE_TEXT = { budget: "it reached its spend limit", timeout: "it ran out of time", error: "it failed" } as const;
const MAX_NOTE_LINES = 2;
const MAX_NOTE_CHARS = 200;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** At most two non-empty lines of the model's notes, each trimmed to a readable length. */
export function noteLines(notes: string | undefined): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n|;\s+/)
    .map((l) => l.replace(/^[\s\-*•]+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_NOTE_LINES)
    .map((l) => (l.length > MAX_NOTE_CHARS ? `${l.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : l));
}

/**
 * The review summary, built by code with a fixed structure (never the model's free text as a whole):
 * header with mode and source, counts by origin, status lines, then at most two lines of the model's notes.
 */
export function buildSummary(s: SummaryInput): string {
  const header = s.selection ? `**Guardrails** · mode ${s.selection.mode} (${s.selection.detail})` : "**Guardrails**";
  const counts = s.total
    ? `${plural(s.total, "finding", "findings")}: ${s.fromChecks} from checks, ${s.fromModel} from the model` +
      (s.merged ? `, ${plural(s.merged, "merged duplicate", "merged duplicates")}` : "")
    : s.incomplete && !s.modelIncomplete
      ? "The analysis of this change could not be completed. Push a new commit to try again."
      : "No issues found.";
  const status = [
    s.omitted ? `${s.omitted} lower-priority finding(s) omitted: over the review cap.` : "",
    s.passesFailed ? `${s.passesFailed} of ${s.passes ?? 2} review passes did not complete (time or budget); results come from the other pass and the mechanical checks.` : "",
    s.modelIncomplete ? `The model-based review did not complete (${FAILURE_TEXT[s.modelIncomplete]}); only the mechanical check results are shown.` : "",
  ].filter(Boolean);
  const notes = noteLines(s.notes);
  return [header, [counts, ...status].join(" "), s.coverageLine ?? "", notes.join("\n"), s.coverageDetails ?? ""].filter(Boolean).join("\n\n");
}

export interface StatsInput {
  costUsd: number | null;
  ms: number;
  passes: number;
}

/** "Cost ~US$0.02 · 38 s · 2 passes" (cost is "n/a" when the model has no known price). */
export function statsFooter(s: StatsInput): string {
  const cost = s.costUsd === null ? "Cost n/a" : `Cost ~US$${s.costUsd.toFixed(2)}`;
  return [cost, `${Math.round(s.ms / 1000)} s`, plural(s.passes, "pass", "passes")].join(" · ");
}
