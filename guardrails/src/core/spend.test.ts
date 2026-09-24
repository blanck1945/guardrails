import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimateRun, planSpend, PROFILES } from "./spend";

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
      env: { PATH: process.env.PATH ?? "", ...env },
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
