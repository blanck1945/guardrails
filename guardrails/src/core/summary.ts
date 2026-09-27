import { messages, type Language } from "./i18n";
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

const NL = String.fromCharCode(10);
const MAX_NOTE_LINES = 2;
const MAX_NOTE_CHARS = 200;

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
export function buildSummary(s: SummaryInput, lang?: Language): string {
  const m = messages(lang).summary;
  const header = s.selection ? m.header(s.selection.mode, s.selection.detail) : "**Guardrails**";
  const counts = s.total
    ? m.findings(s.total, s.fromChecks, s.fromModel, s.merged ?? 0)
    : s.incomplete && !s.modelIncomplete
      ? m.couldNotComplete
      : m.noIssues;
  const status = [
    s.omitted ? m.omitted(s.omitted) : "",
    s.passesFailed ? m.passesFailed(s.passesFailed, s.passes ?? 2) : "",
    s.modelIncomplete ? m.modelFailed(s.modelIncomplete) : "",
  ].filter(Boolean);
  const notes = noteLines(s.notes);
  return [header, [counts, ...status].join(" "), s.coverageLine ?? "", notes.join(NL), s.coverageDetails ?? ""].filter(Boolean).join(NL + NL);
}

export interface StatsInput {
  costUsd: number | null;
  ms: number;
  passes: number;
}

/** "Cost ~US$0.02 · 38 s · 2 passes" (cost is "n/a" when the model has no known price). */
export function statsFooter(s: StatsInput, lang?: Language): string {
  return messages(lang).summary.stats(s.costUsd, Math.round(s.ms / 1000), s.passes);
}
