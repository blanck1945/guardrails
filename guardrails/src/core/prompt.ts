import type { GuardrailsConfig } from "./config";
import type { ReviewInput } from "./types";

const STRICTNESS = {
  1: "Report only definite, high-impact bugs. Skip anything you are not sure about.",
  2: "Report likely bugs and meaningful risks. Skip nitpicks.",
  3: "Be thorough. Report bugs, risks and smaller issues.",
} as const;

export function buildSystemPrompt(config: GuardrailsConfig): string {
  const rules = config.rules
    .map((r) => `- [${r.id}] (${r.severity}, scope: ${r.scope.join(", ")}) ${r.rule}`)
    .join("\n");

  return [
    "You are a senior code reviewer. Review the pull request diff with the repository context provided.",
    STRICTNESS[config.strictness as 1 | 2 | 3],
    `Only report these comment types: ${config.commentTypes.join(", ")}.`,
    "Every finding must point to a line that exists in the new version of the diff.",
    "Give a confidence between 0 and 1. Do not report what you cannot justify from the code shown.",
    config.instructions && `Team instructions:\n${config.instructions}`,
    rules && `Team rules (report violations with their ruleId):\n${rules}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildUserPrompt(input: ReviewInput): string {
  const block = (title: string, files: Record<string, string>) =>
    Object.keys(files).length
      ? `## ${title}\n` +
        Object.entries(files)
          .map(([p, c]) => `### ${p}\n\`\`\`\n${c}\n\`\`\``)
          .join("\n")
      : "";

  return [
    input.title && `PR title: ${input.title}`,
    input.description && `PR description:\n${input.description}`,
    block("Repository docs", input.docs),
    block("Related files", input.context),
    `## Diff\n\`\`\`diff\n${input.diff}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n");
}
