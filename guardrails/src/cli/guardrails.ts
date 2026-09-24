/**
 * Local CLI. Usage: pnpm guardrails init [--path <dir>] [--write] [--min-confidence <0-1>]
 *                                        [--include-tool-enforced] [--model <id>]
 * Model: `--model` or GUARDRAILS_MODEL (`zai:<id>`, `deepseek:<id>` or an AI Gateway id). Needs the matching
 * credential in the environment or .env.local (ZAI_API_KEY, DEEPSEEK_API_KEY, AI_GATEWAY_API_KEY; see .env.example).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatInitReport, runInit } from "../core/init";
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
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      path: { type: "string", default: "." },
      write: { type: "boolean", default: false },
      "min-confidence": { type: "string" },
      "include-tool-enforced": { type: "boolean", default: false },
      model: { type: "string" },
    },
  });
  if (positionals[0] !== "init") {
    console.error("Usage: guardrails init [--path <dir>] [--write] [--min-confidence <0-1>] [--include-tool-enforced] [--model <id>]");
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

  const root = path.resolve(values.path);
  const rulesFile = path.join(root, RULES_PATH);
  const workspace = new LocalWorkspace({ root });
  const result = await runInit({
    workspace,
    model: values.model,
    existingRulesMd: await readOptional(rulesFile),
    existingConfigJson: await readOptional(path.join(root, CONFIG_PATH)),
    minConfidence: min,
    includeToolEnforced: values["include-tool-enforced"],
  });

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
