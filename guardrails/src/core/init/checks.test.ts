import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { validateChecks } from "./checks";
import { normalizeCandidates, synthesisInstructions, synthesizeRules, type CandidateRule } from "./synthesize";
import { mergeSuggestions } from "./write";
import { parseRulesMd } from "../rules/parse";

const cand = (over: Partial<CandidateRule> & { id: string }): CandidateRule => ({
  rule: `Rule text for ${over.id}`,
  scope: ["src/**"],
  severity: "medium",
  source: "CLAUDE.md",
  confidence: 0.9,
  kind: "diff-checkable",
  ...over,
});

describe("init proposes checks", () => {
  it("the synthesis prompt explains each check type", () => {
    const p = synthesisInstructions(10);
    for (const s of ["max-lines", "colocated-test", "forbid-import", "forbid-pattern"]) expect(p).toContain(s);
  });
  it("keeps a valid check and exclude", () => {
    const r = validateChecks([cand({ id: "a", check: " max-lines: 150 ", exclude: ["**/*.test.ts", " "] })]);
    expect(r.warnings).toEqual([]);
    expect(r.candidates[0]).toMatchObject({ check: "max-lines: 150", exclude: ["**/*.test.ts"] });
  });
  it("discards an invalid check, keeps the rule, warns", () => {
    const r = validateChecks([cand({ id: "a", check: "max-lines: lots", exclude: ["x/**"] }), cand({ id: "b", check: "forbid-pattern: (a+)+$" })]);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]!.check).toBeUndefined();
    expect(r.candidates[0]!.exclude).toBeUndefined();
    expect(r.warnings.map((w) => w.id)).toEqual(["a", "b"]);
  });
  it("normalizeCandidates and mergeSuggestions carry the check into rules.md", () => {
    const [n] = normalizeCandidates([cand({ id: "short", check: "max-lines: 150", exclude: ["gen/**"] })]);
    const { text, added } = mergeSuggestions(null, [n!]);
    expect(added[0]).toMatchObject({ check: "max-lines: 150", exclude: ["gen/**"], status: "suggested" });
    const parsed = parseRulesMd(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rules[0]).toMatchObject({ check: "max-lines: 150", exclude: ["gen/**"] });
  });
  it("the model output can carry a check through the schema", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ rules: [{ id: "tests", rule: "Every module has a colocated test.", scope: ["src/**"], severity: "medium", source: "CLAUDE.md", confidence: 0.9, kind: "diff-checkable", check: "colocated-test" }] }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    });
    const ctx = { files: [{ path: "CLAUDE.md", kind: "docs", content: "x", truncated: false }], structure: "", skipped: [], totalChars: 1 };
    const r = await synthesizeRules(ctx as never, { model });
    expect(r.candidates[0]!.check).toBe("colocated-test");
  });
});
