import { describe, expect, it } from "vitest";
import { defaultConfig, safeParseConfig } from "./config";
import { autoRuleMatches, describeMode, MODE_PRESETS, modesFromDescription, modesFromLabels, selectMode, statsOfDiff, type ChangeStats } from "./modes";

const cfg = (over: Record<string, unknown> = {}) => safeParseConfig(JSON.stringify(over)).config;
const stats = (files: string[], linesChanged = 10): ChangeStats => ({ files, linesChanged });
const sel = (over: Partial<Parameters<typeof selectMode>[0]> = {}) => selectMode({ config: defaultConfig, stats: stats(["src/a.ts"]), ...over });

describe("presets", () => {
  it("match the documented values", () => {
    const { basic, standard, deep } = MODE_PRESETS;
    expect([basic.maxSteps, basic.budgetUsd, basic.minConfidence, basic.findingCap, basic.passes, basic.ruleChecks]).toEqual([4, 0.05, 0.8, 3, 1, "off"]);
    expect([standard.maxSteps, standard.budgetUsd, standard.minConfidence, standard.findingCap, standard.passes]).toEqual([12, 0.25, null, null, 1]);
    expect([deep.maxSteps, deep.budgetUsd, deep.minConfidence, deep.findingCap, deep.passes, deep.ruleChecks]).toEqual([24, 0.75, 0.4, 12, 2, "require"]);
    for (const p of Object.values(MODE_PRESETS)) expect(p.timeoutSec).toBeLessThanOrEqual(240);
  });
});

describe("selectMode priority", () => {
  it("defaults to standard", () => {
    expect(sel()).toMatchObject({ mode: "standard", source: "default" });
  });
  it("config mode is the default", () => {
    expect(sel({ config: cfg({ mode: "deep" }) })).toMatchObject({ mode: "deep", source: "config-default" });
  });
  it("autoMode beats config mode; first match wins", () => {
    const config = cfg({ mode: "basic", autoMode: [{ filesGreaterThan: 5, mode: "deep" }, { filesGreaterThan: 1, mode: "standard" }] });
    expect(sel({ config, stats: stats(["a", "b", "c"]) })).toMatchObject({ mode: "standard", source: "auto-mode" });
    expect(sel({ config, stats: stats(["a", "b", "c", "d", "e", "f"]) })).toMatchObject({ mode: "deep", source: "auto-mode" });
    expect(sel({ config, stats: stats(["a"]) })).toMatchObject({ mode: "basic", source: "config-default" });
  });
  it("description beats autoMode; label beats description; cli beats all", () => {
    const config = cfg({ autoMode: [{ filesGreaterThan: 0, mode: "basic" }] });
    const description = "Fixes stuff\n\nguardrails-mode: deep\n";
    expect(sel({ config, description })).toMatchObject({ mode: "deep", source: "description" });
    expect(sel({ config, description, labels: ["guardrails:standard"] })).toMatchObject({ mode: "standard", source: "label" });
    expect(sel({ config, description, labels: ["guardrails:standard"], cli: "basic" })).toMatchObject({ mode: "basic", source: "cli" });
  });
  it("labels are case-insensitive, unrelated labels are ignored, the strictest label wins", () => {
    expect(modesFromLabels(["bug", "Guardrails:BASIC", "guardrails:deep", "guardrails:other", "guardrails:"])).toEqual(["basic", "deep"]);
    expect(sel({ labels: ["Guardrails:Basic", "GUARDRAILS:DEEP", "guardrails:standard"] })).toMatchObject({ mode: "deep", source: "label" });
    expect(sel({ labels: ["bug"] })).toMatchObject({ source: "default" });
  });
  it("description line: case-insensitive, whole line only, strictest wins", () => {
    expect(modesFromDescription("GuardRails-Mode:   basic")).toEqual(["basic"]);
    expect(modesFromDescription("please guardrails-mode: deep here")).toEqual([]);
    expect(modesFromDescription("guardrails-mode: basic\nguardrails-mode: deep")).toEqual(["basic", "deep"]);
    expect(modesFromDescription(null)).toEqual([]);
    expect(sel({ description: "guardrails-mode: basic\nguardrails-mode: deep" }).mode).toBe("deep");
  });
  it("prOverride none: neither labels nor description can change the mode", () => {
    const config = cfg({ prOverride: "none", mode: "deep" });
    expect(sel({ config, labels: ["guardrails:basic"], description: "guardrails-mode: basic" })).toMatchObject({ mode: "deep", source: "config-default" });
    // the CLI flag still applies
    expect(sel({ config, labels: ["guardrails:basic"], cli: "standard" })).toMatchObject({ mode: "standard", source: "cli" });
  });
  it("explains itself", () => {
    expect(describeMode(sel({ labels: ["guardrails:deep"] }))).toBe("Review mode: deep (label guardrails:deep).");
    expect(describeMode(sel())).toBe("Review mode: standard (default).");
  });
});

describe("autoMode conditions", () => {
  const rule = (r: Record<string, unknown>) => cfg({ autoMode: [{ mode: "deep", ...r }] }).autoMode[0]!;
  it("filesGreaterThan / filesLessThan", () => {
    expect(autoRuleMatches(rule({ filesGreaterThan: 2 }), stats(["a", "b", "c"]))).toBe(true);
    expect(autoRuleMatches(rule({ filesGreaterThan: 3 }), stats(["a", "b", "c"]))).toBe(false);
    expect(autoRuleMatches(rule({ filesLessThan: 3 }), stats(["a", "b"]))).toBe(true);
    expect(autoRuleMatches(rule({ filesLessThan: 2 }), stats(["a", "b"]))).toBe(false);
  });
  it("linesChangedGreaterThan", () => {
    expect(autoRuleMatches(rule({ linesChangedGreaterThan: 100 }), stats(["a"], 101))).toBe(true);
    expect(autoRuleMatches(rule({ linesChangedGreaterThan: 100 }), stats(["a"], 100))).toBe(false);
  });
  it("onlyPaths needs every file to match", () => {
    const r = rule({ onlyPaths: ["docs/**", "*.md"] });
    expect(autoRuleMatches(r, stats(["docs/a.txt", "README.md"]))).toBe(true);
    expect(autoRuleMatches(r, stats(["docs/a.txt", "src/a.ts"]))).toBe(false);
    expect(autoRuleMatches(r, stats([]))).toBe(false);
  });
  it("touchesPaths needs one file to match", () => {
    const r = rule({ touchesPaths: ["src/auth/**"] });
    expect(autoRuleMatches(r, stats(["README.md", "src/auth/login.ts"]))).toBe(true);
    expect(autoRuleMatches(r, stats(["README.md"]))).toBe(false);
  });
  it("conditions of one entry are ANDed", () => {
    const r = rule({ filesGreaterThan: 1, touchesPaths: ["src/**"] });
    expect(autoRuleMatches(r, stats(["src/a.ts", "b"]))).toBe(true);
    expect(autoRuleMatches(r, stats(["src/a.ts"]))).toBe(false);
  });
  it("an entry without conditions or with a bad mode is rejected by the config", () => {
    const bad = safeParseConfig(JSON.stringify({ autoMode: [{ mode: "deep" }] }));
    expect(bad.errors.map((e) => e.path)).toContain("autoMode.0");
    expect(bad.config.autoMode).toEqual([]);
    expect(safeParseConfig(JSON.stringify({ mode: "turbo" })).errors.map((e) => e.path)).toContain("mode");
    expect(safeParseConfig(JSON.stringify({ prOverride: "x" })).errors.map((e) => e.path)).toContain("prOverride");
    expect(defaultConfig.prOverride).toBe("labels");
  });
});

describe("statsOfDiff", () => {
  it("counts files and added+removed lines", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n ctx\n-old\n+new1\n+new2\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    expect(statsOfDiff(diff)).toEqual({ files: ["a.ts", "b.ts"], linesChanged: 5 });
  });
});
