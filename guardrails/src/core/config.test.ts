import { describe, it, expect } from "vitest";
import { safeParseConfig, defaultConfig } from "./config";

describe("safeParseConfig", () => {
  it("returns defaults for empty input", () => {
    for (const raw of [undefined, null, "", "  "]) {
      const r = safeParseConfig(raw);
      expect(r.config).toEqual(defaultConfig);
      expect(r.errors).toEqual([]);
    }
    expect(defaultConfig.packs).toEqual([]);
    expect(defaultConfig.disabledRules).toEqual([]);
    expect(defaultConfig.triggers).toEqual({ drafts: false, forks: true, skipLabels: ["skip-guardrails"] });
  });

  it("returns defaults + 1 error for invalid JSON", () => {
    const r = safeParseConfig("{nope");
    expect(r.config).toEqual(defaultConfig);
    expect(r.errors).toHaveLength(1);
  });

  it("falls back to the field default and reports the path", () => {
    const r = safeParseConfig(JSON.stringify({ strictness: 9, instructions: "be kind", packs: ["security"] }));
    expect(r.config.strictness).toBe(defaultConfig.strictness);
    expect(r.config.instructions).toBe("be kind");
    expect(r.config.packs).toEqual(["security"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.path).toBe("strictness");
  });

  it("reports nested paths and applies partial trigger defaults", () => {
    const r = safeParseConfig(JSON.stringify({ triggers: { drafts: "yes" } }));
    expect(r.errors[0]!.path).toBe("triggers.drafts");
    expect(r.config.triggers).toEqual(defaultConfig.triggers);
    const ok = safeParseConfig(JSON.stringify({ triggers: { drafts: true } }));
    expect(ok.config.triggers).toEqual({ drafts: true, forks: true, skipLabels: ["skip-guardrails"] });
  });

  it("rejects non-object JSON", () => {
    expect(safeParseConfig("[]").errors).toHaveLength(1);
  });
});
