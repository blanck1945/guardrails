/**
 * Local CLI. `pnpm guardrails smoke` runs one minimal real-model check (see smoke.ts). Usage: pnpm guardrails init [--path <dir>] [--write] [--min-confidence <0-1>]
 *                                        [--include-tool-enforced] [--model <id>]
 *                                        [--budget-usd <N>] [--dry-run] [--yes] [--llm-cache]
 * Model: `--model` or GUARDRAILS_MODEL (`zai:<id>`, `deepseek:<id>` or an AI Gateway id). Needs the matching
 * credential in the environment or .env.local (ZAI_API_KEY, DEEPSEEK_API_KEY, AI_GATEWAY_API_KEY; see .env.example).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BudgetExceededError, CostTracker } from "../core/cost";
import { formatInitReport, runInit } from "../core/init";
import { collectRepoContext } from "../core/init/collect";
import { buildSynthesisPrompt, SYNTHESIS_INSTRUCTIONS } from "../core/init/synthesize";
import { defaultModelSpec } from "../core/models";
import { estimateRun, planSpend, PROFILES, type RunProfile } from "../core/spend";
import { LocalWorkspace } from "../core/workspace";

const RULES_PATH = ".guardrails/rules.md";
const CONFIG_PATH = ".guardrails/config.json";

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "smoke") {
    for (const file of [".env.local", ".env"]) {
      try {
        process.loadEnvFile(file);
      } catch {
        /* missing */
      }
    }
    await (await import("./smoke")).smoke();
    return Number(process.exitCode ?? 0);
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      path: { type: "string", default: "." },
      write: { type: "boolean", default: false },
      "min-confidence": { type: "string" },
      "include-tool-enforced": { type: "boolean", default: false },
      model: { type: "string" },
      "budget-usd": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      "llm-cache": { type: "boolean", default: false },
    },
  });
  if (positionals[0] !== "init") {
    console.error("Usage: guardrails init [--path <dir>] [--write] [--min-confidence <0-1>] [--include-tool-enforced] [--model <id>] [--budget-usd <N>] [--dry-run] [--yes] [--llm-cache]");
    return 2;
  }
  const min = values["min-confidence"] === undefined ? undefined : Number(values["min-confidence"]);
  if (min !== undefined && !(min >= 0 && min <= 1)) {
    console.error("--min-confidence must be a number between 0 and 1");
    return 2;
  }

  // The tool's own credentials (never the target repo's .env).
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file); // never overrides variables that are already set
    } catch {
      /* file missing: rely on the process environment */
    }
  }

  const budgetUsd = values["budget-usd"] === undefined ? undefined : Number(values["budget-usd"]);
  if (budgetUsd !== undefined && !(budgetUsd > 0)) {
    console.error("--budget-usd must be a positive number");
    return 2;
  }

  // Dev/eval only: replay identical model calls from eval/.cache/llm (same as GUARDRAILS_LLM_CACHE=1).
  if (values["llm-cache"]) process.env.GUARDRAILS_LLM_CACHE = "1";

  const root = path.resolve(values.path);
  const rulesFile = path.join(root, RULES_PATH);
  const workspace = new LocalWorkspace({ root });

  // Estimate before spending: the input size is known from what the collector reads.
  const modelSpec = values.model ?? defaultModelSpec();
  const context = await collectRepoContext(workspace);
  const profile: RunProfile = {
    ...PROFILES.init,
    inputTokens: Math.ceil((SYNTHESIS_INSTRUCTIONS.length + buildSynthesisPrompt(context).length) / 4),
    basis: "collected docs at ~4 chars/token; output assumed",
  };
  const plan = planSpend({
    estimate: estimateRun(modelSpec, context.files.length ? 1 : 0, profile),
    budgetUsd,
    yes: values.yes,
    dryRun: values["dry-run"],
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  if (plan.action !== "run") {
    (plan.action === "refuse" ? console.error : console.log)(plan.message);
    return plan.action === "refuse" ? 2 : 0;
  }
  console.error(plan.message);

  const tracker =
    budgetUsd === undefined ? undefined : new CostTracker({ maxUsd: budgetUsd, onWarn: (m) => console.error(`warning: ${m}`) });
  let result;
  try {
    result = await runInit({
    workspace,
    costTracker: tracker,
    model: values.model,
    existingRulesMd: await readOptional(rulesFile),
    existingConfigJson: await readOptional(path.join(root, CONFIG_PATH)),
    minConfidence: min,
    includeToolEnforced: values["include-tool-enforced"],
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const s = err.snapshot;
      console.error(`${err.message}. Executed before stopping: ${s.calls} call(s), ${s.totalTokens} tokens, $${s.costUsd.toFixed(4)}${s.complete ? "" : " (+ unpriced tokens)"}. Nothing was written.`);
      return 3;
    }
    throw err;
  }

  if (values.write && result.merge.added.length) {
    await fs.mkdir(path.dirname(rulesFile), { recursive: true });
    await fs.writeFile(rulesFile, result.merge.text, "utf8");
  }
  console.log(formatInitReport(result, { write: values.write, rulesPath: RULES_PATH }));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`guardrails: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
