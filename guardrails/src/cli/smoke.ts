/**
 * `pnpm guardrails smoke`: one minimal pass against a REAL model (the only place that calls one on purpose).
 *   1. plain text call
 *   2. forced `report_findings` tool call with the real schema v2
 *   3. reviewDiff in agent mode over a tiny temp git repo with an obvious bug
 * Capped at US$0.05 through a CostTracker. Never prints credentials.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateText } from "ai";
import { createReportTool, REPORT_TOOL } from "../core/agent/tools";
import { defaultConfig } from "../core/config";
import { BudgetExceededError, CostTracker } from "../core/cost";
import { defaultModelSpec, resolveModel } from "../core/models";
import { reviewDiff } from "../core/review";
import { LocalWorkspace } from "../core/workspace";

const MAX_USD = 0.05;

const BASE = `export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i]!;
  }
  return total;
}
`;

// Two obvious bugs: off-by-one bound and an assignment inside a condition.
const HEAD = `export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i]!;
  }
  return total;
}

export function firstOrDefault(values: number[] | null, fallback: number): number {
  let result = fallback;
  if (values = null) {
    return result;
  }
  result = values[0] ?? fallback;
  return result;
}
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

function fmtCost(usd: number | null): string {
  return usd === null ? "unknown (no known price)" : `$${usd.toFixed(5)}`;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  console.log(`\n== ${name}`);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BudgetExceededError) console.log(`STOPPED: ${err.message}`);
    else console.log(`FAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    process.exitCode = 1;
    return undefined;
  }
}

export async function smoke(): Promise<void> {
  const spec = defaultModelSpec();
  const tracker = new CostTracker({ maxUsd: MAX_USD, onWarn: (m) => console.log(`warning: ${m}`) });
  const model = resolveModel(spec, { tracker });
  console.log(`model: ${spec}  (cap $${MAX_USD})`);

  await step("1. text call", async () => {
    const r = await generateText({ model, prompt: "Reply with exactly one word: pong" });
    console.log(`text: ${JSON.stringify(r.text)}`);
    console.log(`usage: ${JSON.stringify(r.usage)}`);
  });

  await step("2. forced report_findings tool call (schema v2)", async () => {
    const r = await generateText({
      model,
      instructions: "You review code. Report bugs through the report_findings tool.",
      prompt: "File src/a.ts line 3: `for (let i = 0; i <= arr.length; i++)` iterates over an array. Report any finding, citing evidence.",
      tools: { [REPORT_TOOL]: createReportTool(() => undefined) },
      toolChoice: { type: "tool", toolName: REPORT_TOOL },
    });
    const call = r.toolCalls[0];
    console.log(`tool called: ${call?.toolName ?? "NONE"}, invalid: ${call ? Boolean((call as { invalid?: boolean }).invalid) : "n/a"}`);
    console.log(`input: ${JSON.stringify(call?.input)}`);
    console.log(`finishReason: ${r.finishReason}; usage: ${JSON.stringify(r.usage)}`);
  });

  await step("3. reviewDiff (agent) on a temp repo with an obvious bug", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "guardrails-smoke-"));
    try {
      git(repo, "init", "-q");
      mkdirSync(path.join(repo, "src"));
      writeFileSync(path.join(repo, "src/util.ts"), BASE);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "base");
      const baseRef = git(repo, "rev-parse", "HEAD");
      writeFileSync(path.join(repo, "src/util.ts"), HEAD);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "feature");
      const workspace = new LocalWorkspace({ root: repo, baseRef, headRef: "HEAD" });
      const r = await reviewDiff({ diff: "", context: {}, docs: {}, title: "Add firstOrDefault" }, { config: defaultConfig, model: spec, mode: "agent", workspace, costTracker: tracker });
      console.log(`incomplete: ${r.incomplete}; steps: ${r.usage.steps}`);
      console.log(`findings (${r.findings.length}):`);
      for (const f of r.findings) console.log(`  - ${f.file}:${f.line} [${f.severity}/${f.type}, conf ${f.confidence}] ${f.title}`);
      for (const d of r.dropped) console.log(`  dropped (${d.reason}): ${d.finding.file}:${d.finding.line} [${d.finding.type}, conf ${d.finding.confidence}] ${d.finding.title}`);
      if (r.notes) console.log(`notes: ${r.notes}`);
      console.log(`usage: ${JSON.stringify(r.usage)}`);
      console.log(`review cost: ${fmtCost(r.costUsd)}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  const s = tracker.snapshot();
  console.log(`\n== total: ${s.calls} model call(s), ${s.totalTokens} tokens, cost ${s.complete ? fmtCost(s.costUsd) : "unknown (unpriced model)"}`);
}
