import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { reviewDiff, serializeRulesMd, type Rule } from "@/core";
import { buildAgentInstructions } from "@/core/agent";
import { buildSystemPrompt } from "@/core/prompt";
import { defaultConfig } from "@/core/config";
import { stripUnknownRuleIds, selectRulesForFiles } from "@/core/rules";
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

describe("stripUnknownRuleIds", () => {
  it("keeps every finding; unknown or inactive rule ids are stripped, known ones stay", () => {
    const rules = [mk({ id: "known" }), mk({ id: "sugg", status: "suggested" })];
    const out = stripUnknownRuleIds(
      [{ t: "a" }, { t: "b", ruleId: "known" }, { t: "c", ruleId: "ghost" }, { t: "d", ruleId: "sugg" }],
      rules,
    );
    expect(out.map((f) => f.t)).toEqual(["a", "b", "c", "d"]);
    expect(out.map((f) => f.ruleId)).toEqual([undefined, "known", undefined, undefined]);
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

describe("reviewDiff strips unknown rule ids", () => {
  const finding = (title: string, ruleId?: string, line = 1) => ({
    file: "src/a.ts",
    line,
    type: "logic",
    severity: "high",
    confidence: 0.9,
    title,
    body: "b",
    ...(ruleId ? { ruleId } : {}),
  });
  it("keeps every finding and strips ruleIds that were never given to the model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              summary: "s",
              findings: [finding("generic"), finding("known", "english-only"), finding("ghost", "made-up", 2)],
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
    expect(r.findings.map((f) => f.title)).toEqual(["generic", "known", "ghost"]);
    expect(r.findings.map((f) => f.ruleId)).toEqual([undefined, "english-only", undefined]);
  });
});

describe("reviewDiff comment-type filter vs rules", () => {
  const f = (title: string, type: string, extra: object = {}) => ({
    file: "src/a.ts", line: 1, type, severity: "medium", confidence: 0.95, title, body: "b", ...extra,
  });
  const run = async (findings: object[]) => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ summary: "s", findings }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    return reviewDiff(
      { diff: "+x", context: {}, docs: {} },
      { config: { ...defaultConfig, rules: [mk({ id: "english-only" }), mk({ id: "sugg-rule", status: "suggested" })] }, model },
    );
  };

  it("keeps a style finding that cites an active rule", async () => {
    const r = await run([f("spanish", "style", { ruleId: "english-only" })]);
    expect(r.findings.map((x) => x.ruleId)).toEqual(["english-only"]);
    expect(r.dropped).toEqual([]);
  });

  it("still drops a style finding without a rule, with its reason", async () => {
    const r = await run([f("nit", "style")]);
    expect(r.findings).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["comment-type-disabled"]);
  });

  it("strips suggested/unknown rule ids and then applies the type filter", async () => {
    const r = await run([f("a", "style", { ruleId: "sugg-rule" }), f("b", "style", { ruleId: "ghost" }), f("c", "logic", { ruleId: "ghost" })]);
    expect(r.findings.map((x) => [x.title, x.ruleId])).toEqual([["c", undefined]]);
    expect(r.dropped.map((d) => d.finding.title)).toEqual(["a", "b"]);
  });

  it("the confidence filter still applies to rule findings", async () => {
    const r = await run([f("weak", "style", { ruleId: "english-only", confidence: 0.1 })]);
    expect(r.findings).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["low-confidence"]);
  });
});
