import type { GuardrailsConfig } from "./config";
import { formatMechanicalNote, formatRulesForPrompt } from "./rules/format";
import type { ReviewInput } from "./types";

export const STRICTNESS = {
  1: "Report only definite, high-impact bugs. Skip anything you are not sure about.",
  2: "Report likely bugs and meaningful risks. Skip nitpicks.",
  3: "Be thorough. Report bugs, risks and smaller issues.",
} as const;

export function buildSystemPrompt(config: GuardrailsConfig, mechanical: ReadonlySet<string> = new Set()): string {
  const rules = formatRulesForPrompt(config.rules, mechanical);
  const mechanicalNote = formatMechanicalNote(config.rules, mechanical);

  return [
    "You are a senior code reviewer. Review the pull request diff with the repository context provided.",
    STRICTNESS[config.strictness as 1 | 2 | 3],
    `Only report these comment types: ${config.commentTypes.join(", ")}.`,
    "Every finding must point to a line that exists in the new version of the diff.",
    "Give a confidence between 0 and 1. Do not report what you cannot justify from the code shown.",
    "Focus on problems INTRODUCED by this change. Do not report improvements or missing features (for example 'saved but never restored', 'could also handle X') unless they break a team rule or are a real bug in the changed code. Report each problem once: never repeat the same issue under different titles or at the same line.",
    "You only see the diff and the files provided: never claim that a file, test or symbol does not exist (or is never used) elsewhere in the repository; you cannot verify it, so do not state it.",
    config.instructions && `Team instructions:\n${config.instructions}`,
    rules && `Team rules. Whenever a finding violates one of the rules listed below, you MUST set its ruleId field to that rule's id (exactly as listed) and cite the id and its source in the finding body. Rule violations are reported even if their type is not in the list above:\n${rules}`,
    mechanicalNote,
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
