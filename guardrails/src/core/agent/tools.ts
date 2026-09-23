import { tool } from "ai";
import { z } from "zod";
import { reportFindingsSchema, type FindingV2 } from "../findings";
import { WorkspaceError, type Workspace } from "../workspace";

export const REPORT_TOOL = "report_findings";

/** Turns workspace errors into tool output the model can react to. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WorkspaceError) return { error: e.message };
    throw e;
  }
}

/** F1 tools (PLAN-DETAILED §3.3) over a `Workspace`. */
export function createWorkspaceTools(ws: Workspace) {
  return {
    read_file: tool({
      description:
        "Read a file with numbered lines (max 300 lines per call). Use ref 'base' for the pre-PR version.",
      inputSchema: z.object({
        path: z.string(),
        startLine: z.number().int().min(1).optional(),
        endLine: z.number().int().min(1).optional(),
        ref: z.enum(["head", "base"]).optional(),
      }),
      execute: (input) => guarded(() => ws.readFile(input)),
    }),
    grep: tool({
      description: "Search the repository with a regex (git grep). Returns path:line:text, max 60 matches.",
      inputSchema: z.object({
        pattern: z.string(),
        pathGlob: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        fixed: z.boolean().optional(),
      }),
      execute: (input) => guarded(() => ws.grep(input)),
    }),
    list_files: tool({
      description: "List tracked files, optionally filtered by a glob (max 300).",
      inputSchema: z.object({ glob: z.string().optional() }),
      execute: (input) => guarded(() => ws.listFiles(input)),
    }),
    find_references: tool({
      description:
        "Find usages of a symbol by identifier name (no type resolution; results may include unrelated homonyms).",
      inputSchema: z.object({ symbol: z.string(), path: z.string().optional() }),
      execute: (input) => guarded(() => ws.findReferencesByName(input)),
    }),
  };
}

export interface Report {
  findings: FindingV2[];
  notes?: string | undefined;
}

/**
 * Terminal tool. `execute` only runs on input that passed zod validation; invalid
 * input is returned to the model as a tool error by the SDK (the retry path).
 */
export function createReportTool(onReport: (report: Report) => void) {
  return tool({
    description:
      "Report the final findings of the review. Call it exactly once when done; use an empty list if there are no issues.",
    inputSchema: reportFindingsSchema,
    execute: (report) => {
      onReport(report);
      return { ok: true, count: report.findings.length };
    },
  });
}
