import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { reviewDiff, serializeRulesMd, type Rule } from "@/core";
import { buildAgentInstructions } from "@/core/agent";
import { buildSystemPrompt } from "@/core/prompt";
import { defaultConfig } from "@/core/config";
import { dropUnknownRuleFindings, selectRulesForFiles } from "@/core/rules";
import { loadReviewRules, ruleCitation, rulesChangeNote, rulesForPr } from "./review-rules";

const mk = (over: Partial<Rule> & { id: string }): Rule => ({
  rule: `Body of ${over.id}.\nSecond line.`,
  scope: ["**"],
  severity: "medium",
  status: "active",
  ...over,
});

describe("selectRulesForFiles", () => {
  const rules = [
    mk({ id: "ts-only", scope: ["src/**/*.{ts,tsx}"] }),
    mk({ id: "panel-public", scope: ["panel/public/**"] }),
    mk({ id: "any-md", scope: ["*.md"] }), // no slash: basename at any depth
    mk({ id: "everywhere" }),
    mk({ id: "hidden", scope: [".github/**"] }),
    mk({ id: "pending", status: "suggested" }),
    mk({ id: "off", status: "disabled" }),
  ];

  it("keeps only active rules whose scope matches a changed file", () => {
    const ids = (files: string[]) => selectRulesForFiles(rules, files).map((r) => r.id);
    expect(ids(["src/a/b.ts"])).toEqual(["ts-only", "everywhere"]);
    expect(ids(["docs/guide/readme.md"])).toEqual(["any-md", "everywhere"]);
    expect(ids(["panel/public/index.html", "src/x.tsx"])).toEqual(["ts-only", "panel-public", "everywhere"]);
    expect(ids([".github/workflows/ci.yml"])).toEqual(["everywhere", "hidden"]);
    expect(ids(["lib/x.py"])).toEqual(["everywhere"]);
  });

  it("never includes suggested or disabled rules, whatever the scope", () => {
    const ids = selectRulesForFiles(rules, ["src/a.ts", "README.md"]).map((r) => r.id);
    expect(ids).not.toContain("pending");
    expect(ids).not.toContain("off");
  });

  it("returns nothing when no file matches", () => {
    expect(selectRulesForFiles([mk({ id: "a-rule", scope: ["src/**"] })], ["docs/a.md"])).toEqual([]);
  });
});

describe("dropUnknownRuleFindings", () => {
  it("keeps findings without ruleId or with a present rule, drops unknown ones", () => {
    const rules = [mk({ id: "known" }), mk({ id: "sugg", status: "suggested" })];
    const out = dropUnknownRuleFindings(
      [{ t: "a" }, { t: "b", ruleId: "known" }, { t: "c", ruleId: "ghost" }, { t: "d", ruleId: "sugg" }],
      rules,
    );
    expect(out.map((f) => f.t)).toEqual(["a", "b"]);
  });
});

describe("loadReviewRules (base vs head)", () => {
  const baseMd = serializeRulesMd([mk({ id: "strict-rule", severity: "high", source: "CLAUDE.md" })]);
  const headMd = serializeRulesMd([mk({ id: "weakened", severity: "low" })]);

  it("reads config and rules.md at the base sha and never at head", async () => {
    const calls: string[] = [];
    const read = async (path: string, ref: string) => {
      calls.push(`${ref}:${path}`);
      if (ref === "BASE" && path.endsWith("rules.md")) return baseMd;
      if (ref === "HEAD" && path.endsWith("rules.md")) return headMd;
      if (ref === "BASE" && path.endsWith("config.json")) return JSON.stringify({ strictness: 3, ignorePatterns: ["gen/**"] });
      if (ref === "HEAD" && path.endsWith("config.json")) return JSON.stringify({ strictness: 1 });
      return null;
    };
    const loaded = await loadReviewRules(read, "BASE");
    expect(loaded.active.map((r) => r.id)).toEqual(["strict-rule"]);
    expect(loaded.config.strictness).toBe(3);
    expect(calls.every((c) => c.startsWith("BASE:"))).toBe(true);
  });

  it("uses defaults when the files do not exist in base", async () => {
    const loaded = await loadReviewRules(async () => null, "BASE");
    expect(loaded.active).toEqual([]);
    expect(loaded.config).toEqual(defaultConfig);
  });

  it("only suggested rules in base means no rules reach the PR", async () => {
    const md = serializeRulesMd([mk({ id: "pending", status: "suggested" })]);
    const loaded = await loadReviewRules(async (p) => (p.endsWith("rules.md") ? md : null), "BASE");
    expect(rulesForPr(loaded, ["src/a.ts"])).toEqual([]);
  });
});

describe("rules change note and citation", () => {
  it("flags PRs that edit rules.md or config.json", () => {
    expect(rulesChangeNote(["src/a.ts"])).toBeNull();
    expect(rulesChangeNote(["src/a.ts", ".guardrails/rules.md"])).toMatch(/rules\.md/);
    expect(rulesChangeNote([".guardrails/config.json"])).toMatch(/base branch/);
  });

  it("cites rule and source", () => {
    const rules = [mk({ id: "english-only", source: "CLAUDE.md" }), mk({ id: "no-src" })];
    expect(ruleCitation("english-only", rules)).toBe("Rule `english-only` (CLAUDE.md)");
    expect(ruleCitation("no-src", rules)).toBe("Rule `no-src`");
    expect(ruleCitation("ghost", rules)).toBeNull();
    expect(ruleCitation(undefined, rules)).toBeNull();
  });
});

describe("prompts", () => {
  const config = {
    ...defaultConfig,
    rules: [
      mk({ id: "english-only", severity: "high", scope: ["src/**"], source: "CLAUDE.md", rule: "Write English.\n```ts\nconst a = 1;\n```" }),
      mk({ id: "hidden-rule", status: "suggested" }),
    ],
  };

  it("single and agent prompts list active rules with id, severity, scope, source and body", () => {
    const budget = { maxSteps: 5 } as Parameters<typeof buildAgentInstructions>[1];
    for (const p of [buildSystemPrompt(config), buildAgentInstructions(config, budget)]) {
      expect(p).toContain("[english-only] (high; scope: src/**; source: CLAUDE.md)");
      expect(p).toContain("Write English.");
      expect(p).toContain("const a = 1;");
      expect(p).not.toContain("hidden-rule");
    }
  });
});

describe("reviewDiff drops findings that cite unknown rules", () => {
  const finding = (title: string, ruleId?: string) => ({
    file: "src/a.ts",
    line: 1,
    type: "logic",
    severity: "high",
    confidence: 0.9,
    title,
    body: "b",
    ...(ruleId ? { ruleId } : {}),
  });
  it("keeps generic findings and known rules only", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: "s",
              findings: [finding("generic"), finding("known", "english-only"), finding("ghost", "made-up")],
            }),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const r = await reviewDiff(
      { diff: "+x", context: {}, docs: {} },
      { config: { ...defaultConfig, rules: [mk({ id: "english-only" })] }, model },
    );
    expect(r.findings.map((f) => f.title)).toEqual(["generic", "known"]);
  });
});
