import { describe, expect, it } from "vitest";
import { loadRules, type Rule } from "../config";
import { activeRules, mergeRules, parseRulesMd, serializeRulesMd } from "./index";

const mk = (over: Partial<Rule> & { id: string }): Rule => ({
  rule: "Do the thing.",
  scope: ["**"],
  severity: "medium",
  status: "active",
  ...over,
});

const SAMPLE = `# My rules
Free comments here.

## english-only
scope: src/**, docs/**
severity: high
source: CLAUDE.md
status: active

All code, comments and prompts must be in English.

Example:

\`\`\`ts
## not a heading
const x = 1;
\`\`\`

## no-hardcoded-domains
severity: low

Do not hardcode domains.
`;

describe("parseRulesMd / serializeRulesMd", () => {
  it("parses blocks, preamble, fenced ## and defaults", () => {
    const r = parseRulesMd(SAMPLE);
    expect(r.errors).toEqual([]);
    expect(r.preamble).toBe("# My rules\nFree comments here.");
    expect(r.rules).toHaveLength(2);
    expect(r.rules[0]).toMatchObject({
      id: "english-only",
      scope: ["src/**", "docs/**"],
      severity: "high",
      source: "CLAUDE.md",
      status: "active",
    });
    expect(r.rules[0]!.rule).toContain("## not a heading");
    expect(r.rules[1]).toMatchObject({ scope: ["**"], severity: "low", status: "active" });
    expect(r.rules[1]!.source).toBeUndefined();
  });

  it("round-trips: parse(serialize(rules)) is the identity and serialize is stable", () => {
    const rules = [
      mk({ id: "a-rule", scope: ["src/**/*.{ts,tsx}", "lib/**"], severity: "high", source: "user", rule: "Line 1\n\n```\n## x\n```\nLine 3" }),
      mk({ id: "b-rule", status: "suggested", source: "docs/lessons.md" }),
      mk({ id: "c-rule", status: "disabled" }),
    ];
    const text = serializeRulesMd(rules, { preamble: "# Notes\nkeep me" });
    const back = parseRulesMd(text);
    expect(back.errors).toEqual([]);
    expect(back.rules).toEqual(rules);
    expect(back.preamble).toBe("# Notes\nkeep me");
    expect(serializeRulesMd(back.rules, { preamble: back.preamble })).toBe(text);
    // and a hand-written file reaches a fixed point after one normalization
    const once = parseRulesMd(SAMPLE);
    const norm = serializeRulesMd(once.rules, { preamble: once.preamble });
    const twice = parseRulesMd(norm);
    expect(serializeRulesMd(twice.rules, { preamble: twice.preamble })).toBe(norm);
  });

  it("reports errors with line numbers and keeps valid rules", () => {
    const text = [
      "## ok-rule", // 1
      "Body.", // 2
      "", // 3
      "## Bad_Id", // 4
      "Body.", // 5
      "",
      "## bad-severity", // 7
      "severity: urgent", // 8
      "",
      "Body.",
      "",
      "## empty-body", // 12
      "scope: **",
      "",
      "## ok-rule", // 15 duplicate
      "Other body.",
    ].join("\n");
    const r = parseRulesMd(text);
    expect(r.rules.map((x) => x.id)).toEqual(["ok-rule"]);
    expect(r.rules[0]!.rule).toBe("Body.");
    expect(r.errors.map((e) => [e.line, e.id])).toEqual([
      [4, "Bad_Id"],
      [8, "bad-severity"],
      [12, "empty-body"],
      [15, "ok-rule"],
    ]);
    expect(r.errors[3]!.message).toMatch(/duplicate/);
  });

  it("handles empty input and CRLF", () => {
    expect(parseRulesMd("")).toEqual({ rules: [], errors: [], preamble: "" });
    const r = parseRulesMd("## a-b\r\nseverity: high\r\n\r\nBody\r\n");
    expect(r.rules[0]).toMatchObject({ id: "a-b", severity: "high", rule: "Body" });
  });
});

describe("mergeRules / loadRules", () => {
  it("md wins on repeated id; disabledRules and disabled status are respected", () => {
    const cfg = [mk({ id: "a-rule", rule: "config" }), mk({ id: "b-rule" }), mk({ id: "c-rule" })];
    const md = [mk({ id: "a-rule", rule: "md" }), mk({ id: "d-rule", status: "disabled" })];
    const merged = mergeRules(cfg, md, ["b-rule"]);
    expect(merged.find((r) => r.id === "a-rule")!.rule).toBe("md");
    expect(activeRules(merged).map((r) => r.id)).toEqual(["a-rule", "c-rule"]);
  });

  it("excludes suggested rules from active", () => {
    const md = serializeRulesMd([mk({ id: "s-rule", status: "suggested" }), mk({ id: "t-rule" })]);
    const l = loadRules(JSON.stringify({ rules: [{ id: "u-rule", rule: "from config" }] }), md);
    expect(l.rules.map((r) => r.id)).toEqual(["u-rule", "s-rule", "t-rule"]);
    expect(l.active.map((r) => r.id)).toEqual(["u-rule", "t-rule"]);
  });

  it("never throws on bad inputs", () => {
    const l = loadRules("{nope", "## Bad Id\nx");
    expect(l.configErrors).toHaveLength(1);
    expect(l.rulesErrors).toHaveLength(1);
    expect(l.active).toEqual([]);
  });
});
