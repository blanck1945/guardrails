import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimateRun, planSpend, profileFromDiff, PROFILES } from "./spend";

describe("estimateRun", () => {
  it("multiplies runs by the assumed profile and prices it", () => {
    const e = estimateRun("zai:glm-4.5-air", 10, "single");
    // per run: 12k in * $0.2/M + 1.5k out * $1.1/M = $0.00405
    expect(e.usd).toBeCloseTo(0.0405, 6);
    expect(e.totalTokens).toBe(10 * (PROFILES.single.inputTokens + PROFILES.single.outputTokens));
  });

  it("is null for a model without a price", () => {
    expect(estimateRun("acme/unknown", 5, "agent").usd).toBeNull();
  });
});

describe("planSpend", () => {
  const big = estimateRun("anthropic/claude-sonnet-5", 100, "agent"); // well above $1
  const small = estimateRun("zai:glm-4.5-air", 3, "single");

  it("--dry-run only reports the estimate", () => {
    const p = planSpend({ estimate: big, dryRun: true, interactive: false });
    expect(p.action).toBe("dry-run");
    expect(p.message).toMatch(/no model was called/);
  });

  it("refuses an expensive suite non-interactively without --budget-usd or --yes", () => {
    const p = planSpend({ estimate: big, interactive: false });
    expect(p.action).toBe("refuse");
    expect(p.message).toMatch(/--budget-usd/);
  });

  it("runs when a budget or --yes is given, when interactive, or when cheap", () => {
    expect(planSpend({ estimate: big, budgetUsd: 2, interactive: false }).action).toBe("run");
    expect(planSpend({ estimate: big, yes: true, interactive: false }).action).toBe("run");
    expect(planSpend({ estimate: big, interactive: true }).action).toBe("run");
    expect(planSpend({ estimate: small, interactive: false }).action).toBe("run");
  });

  it("treats an unknown price as unsafe non-interactively", () => {
    const p = planSpend({ estimate: estimateRun("acme/unknown", 1, "init"), interactive: false });
    expect(p.action).toBe("refuse");
    expect(p.message).toMatch(/cannot be estimated/);
  });
});

describe("guardrails init CLI", () => {
  const cli = path.resolve(__dirname, "../cli/guardrails.ts");
  const tsx = path.resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");
  const run = (args: string[], env: Record<string, string>) => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "gr-cli-"));
    writeFileSync(path.join(repo, "CLAUDE.md"), "# Rules\nAlways write code in English.\n");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync("git", ["add", "-A"], { cwd: repo });
    return spawnSync(process.execPath, [tsx, cli, "init", "--path", repo, ...args], {
      // No provider keys at all: any attempt to reach a model would fail loudly.
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      cwd: os.tmpdir(),
    });
  };

  it("--dry-run prints the estimate and never resolves or calls a model", () => {
    const r = run(["--dry-run", "--model", "zai:glm-4.5-air"], {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Estimate for 1 run\(s\) on zai:glm-4\.5-air/);
    expect(r.stdout).toMatch(/no model was called/);
  });

  it("refuses non-interactively when the cost cannot be estimated", () => {
    const r = run(["--model", "acme/unknown"], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Refusing to run non-interactively/);
  });
});

describe("profileFromDiff (v0.7.4)", () => {
  // 3 files, 120 changed lines of about 50 chars each, plus headers
  const chars = 120 * 50 + 3 * 200;
  const glm = "zai:glm-5.3"; // the model of the measured runs
  const usd = (mode: "standard" | "deep", c = chars, files = 3) => estimateRun(glm, mode === "deep" ? 2 : 1, profileFromDiff(c, files, mode)).usd!;

  it("grows with the diff size and the file count", () => {
    const sizes = [1_000, 5_000, 20_000, 80_000].map((c) => profileFromDiff(c, 3, "standard").inputTokens);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(profileFromDiff(chars, 8, "standard").outputTokens).toBeGreaterThan(profileFromDiff(chars, 2, "standard").outputTokens);
    expect(usd("standard", 80_000)).toBeGreaterThan(usd("standard", 1_000));
  });

  it("deep costs more than standard, standard more than single", () => {
    expect(usd("deep")).toBeGreaterThan(usd("standard"));
    const single = estimateRun(glm, 1, profileFromDiff(chars, 3, "single")).usd!;
    expect(usd("standard")).toBeGreaterThan(single);
  });

  it("3 files / 120 lines lies within 3x of the measured costs", () => {
    // measured: standard US$0.004 to 0.018, deep US$0.022 to 0.043
    expect(usd("standard")).toBeGreaterThanOrEqual(0.004 / 3);
    expect(usd("standard")).toBeLessThanOrEqual(0.018 * 3);
    expect(usd("deep")).toBeGreaterThanOrEqual(0.022 / 3);
    expect(usd("deep")).toBeLessThanOrEqual(0.043 * 3);
  });

  it("is far below the fixed agent profile for a small PR", () => {
    expect(profileFromDiff(chars, 3, "standard").inputTokens).toBeLessThan(PROFILES.agent.inputTokens / 10);
  });

  it("tolerates an empty diff", () => {
    const p = profileFromDiff(0, 0, "deep");
    expect(p.inputTokens).toBe(3_000);
    expect(p.outputTokens).toBe(500);
  });
});
