import { describe, expect, it } from "vitest";
import { parseReviewArgs } from "./review";

describe("guardrails review --mode / --engine", () => {
  it("--mode takes a review mode", () => {
    for (const m of ["basic", "standard", "deep"] as const) {
      const o = parseReviewArgs(["--mode", m]);
      expect(o.reviewMode).toBe(m);
      expect(o.mode).toBe("agent");
    }
  });
  it("no --mode: mode decided later (config or standard); engine stays agent", () => {
    const o = parseReviewArgs([]);
    expect(o.reviewMode).toBeUndefined();
    expect(o.mode).toBe("agent");
  });
  it("--engine selects agent or single; the old `--mode single` still works", () => {
    expect(parseReviewArgs(["--engine", "single"]).mode).toBe("single");
    const legacy = parseReviewArgs(["--mode", "single"]);
    expect(legacy.mode).toBe("single");
    expect(legacy.reviewMode).toBeUndefined();
    expect(parseReviewArgs(["--engine", "single", "--mode", "deep"])).toMatchObject({ mode: "single", reviewMode: "deep" });
  });
  it("rejects unknown values", () => {
    expect(() => parseReviewArgs(["--mode", "turbo"])).toThrow(/--mode must be basic, standard, deep/);
    expect(() => parseReviewArgs(["--engine", "x"])).toThrow(/--engine/);
  });
});
