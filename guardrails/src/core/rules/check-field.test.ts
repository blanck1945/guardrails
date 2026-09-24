import { describe, expect, it } from "vitest";
import { mergeRules } from "./merge";
import { parseRulesMd, serializeRulesMd } from "./parse";
import { formatMechanicalNote, formatRulesForPrompt } from "./format";

const MD = `## short-files
scope: src/**
severity: high
check: max-lines: 150
exclude: src/gen/**, **/*.{test,spec}.ts
status: active

Files must stay under 150 lines.

## plain
status: active

No check here.
`;

describe("rules.md check and exclude", () => {
  it("parses check and exclude (braces stay whole)", () => {
    const { rules, errors } = parseRulesMd(MD);
    expect(errors).toEqual([]);
    expect(rules[0]).toMatchObject({ id: "short-files", check: "max-lines: 150", exclude: ["src/gen/**", "**/*.{test,spec}.ts"] });
    expect(rules[1]!.check).toBeUndefined();
  });
  it("round-trips stably", () => {
    const first = parseRulesMd(MD);
    const text = serializeRulesMd(first.rules);
    const second = parseRulesMd(text);
    expect(second.rules).toEqual(first.rules);
    expect(serializeRulesMd(second.rules)).toBe(text);
  });
  it("an invalid check is reported and dropped, the rule stays", () => {
    const { rules, errors } = parseRulesMd("## r\ncheck: max-lines: abc\nstatus: active\n\nBody.\n");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.check).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ id: "r", line: 2 });
    expect(errors[0]!.message).toContain("invalid check");
  });
  it("merge keeps check from the md rule", () => {
    const md = parseRulesMd(MD).rules;
    expect(mergeRules([{ id: "short-files", rule: "old", scope: ["**"], severity: "low", status: "active" }], md)[0]!.check).toBe("max-lines: 150");
  });
  it("prompt lists mechanically verified rules separately", () => {
    const rules = parseRulesMd(MD).rules;
    const mech = new Set(["short-files"]);
    expect(formatRulesForPrompt(rules, mech)).not.toContain("short-files");
    expect(formatRulesForPrompt(rules, mech)).toContain("[plain]");
    expect(formatMechanicalNote(rules, mech)).toContain("short-files");
    expect(formatMechanicalNote(rules, new Set())).toBe("");
  });
});
