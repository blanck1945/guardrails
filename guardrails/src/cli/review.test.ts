import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewArgs, resolveRange, runReview, type CliIO, type ReviewCliOptions } from "./review";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const report = (findings: unknown[]): GenResult => ({
  content: [{ type: "tool-call", toolCallId: "r1", toolName: "report_findings", input: JSON.stringify({ findings }) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});

const finding = (over: Record<string, unknown> = {}) => ({
  file: "src/a.ts",
  line: 2,
  type: "logic",
  severity: "high",
  confidence: 0.9,
  title: "Spanish comment",
  body: "Violates english-only.",
  ruleId: "english-only",
  evidence: [{ file: "src/a.ts", startLine: 1, endLine: 3, note: "comment" }],
  ...over,
});

const RULES_BASE = "# Rules\n\n## english-only\nscope: src/**\nseverity: high\nsource: CLAUDE.md\nstatus: active\n\nComments must be in English.\n";
const RULES_HEAD = RULES_BASE + "\n## sneaky-rule\nscope: **\nstatus: active\n\nRule added by the change itself.\n";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

/** Repo with a base commit (on `main`) and a feature commit that also edits rules.md. */
function makeRepo() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "guardrails-review-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(path.join(repo, "src"));
  mkdirSync(path.join(repo, ".guardrails"));
  writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n// hello\nexport const b = 2;\n");
  writeFileSync(path.join(repo, ".guardrails/rules.md"), RULES_BASE);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n// hola mundo\nexport const b = 2;\n");
  writeFileSync(path.join(repo, ".guardrails/rules.md"), RULES_HEAD);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const handle: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { handle, out, err };
}

const opts = (repo: string, model: MockLanguageModelV4 | undefined, over: Partial<ReviewCliOptions> = {}): ReviewCliOptions => ({
  path: repo,
  head: "HEAD",
  mode: "agent",
  model,
  dryRun: false,
  yes: true,
  json: false,
  failOn: "high",
  interactive: false,
  ...over,
});

const modelReporting = (findings: unknown[]) => new MockLanguageModelV4({ doGenerate: async () => report(findings) });

describe("guardrails review", () => {
  it("exits 1 on a finding at or above --fail-on and prints file:line, severity, body and the rule", async () => {
    const { repo } = makeRepo();
    const model = modelReporting([finding()]);
    const c = io();
    const code = await runReview(opts(repo, model), c.handle);
    expect(code).toBe(1);
    const text = c.out.join("\n");
    expect(text).toContain("src/a.ts:2");
    expect(text).toContain("high");
    expect(text).toContain("Spanish comment");
    expect(text).toContain("Rule english-only (CLAUDE.md)");
    expect(text).toContain("Cost:");
  });

  it("exits 0 when there are no findings", async () => {
    const { repo } = makeRepo();
    const c = io();
    expect(await runReview(opts(repo, modelReporting([])), c.handle)).toBe(0);
    expect(c.out.join("\n")).toContain("No findings.");
  });

  it("honors --fail-on: a medium finding passes on high, fails on medium, never fails on none", async () => {
    const { repo } = makeRepo();
    const run = (failOn: ReviewCliOptions["failOn"]) =>
      runReview(opts(repo, modelReporting([finding({ severity: "medium" })]), { failOn }), io().handle);
    expect(await run("high")).toBe(0);
    expect(await run("medium")).toBe(1);
    expect(await run("none")).toBe(0);
  });

  it("--json prints machine-readable output with cost and dropped", async () => {
    const { repo, base, head } = makeRepo();
    const model = modelReporting([finding(), finding({ line: 1, confidence: 0.1, title: "weak" })]);
    const c = io();
    const code = await runReview(opts(repo, model, { json: true }), c.handle);
    expect(code).toBe(1);
    const json = JSON.parse(c.out.join("\n"));
    expect(json.findings).toHaveLength(1);
    expect(json.dropped).toHaveLength(1);
    expect(json.dropped[0].reason).toBe("low-confidence");
    expect(json).toHaveProperty("costUsd");
    expect(json.base).toBe(base);
    expect(json.head).toBe(head);
  });

  it("--dry-run does not call the model", async () => {
    const { repo } = makeRepo();
    const model = modelReporting([finding()]);
    const c = io();
    const code = await runReview(opts(repo, model, { dryRun: true }), c.handle);
    expect(code).toBe(0);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(c.out.join("\n")).toContain("Dry run: no model was called");
  });

  it("reads the rules from the BASE commit: a rule added by the change is not applied", async () => {
    const { repo } = makeRepo();
    const model = modelReporting([]);
    await runReview(opts(repo, model), io().handle);
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("[english-only]");
    expect(prompt).not.toContain("[sneaky-rule]");
  });

  it("filters rules by the scope of the changed files", async () => {
    const { repo } = makeRepo();
    git(repo, "checkout", "-q", "main");
    git(repo, "checkout", "-q", "-b", "docs-only");
    writeFileSync(path.join(repo, "NOTES.md"), "hi\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "docs");
    const model = modelReporting([]);
    await runReview(opts(repo, model, { base: "main" }), io().handle);
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain("english-only");
  });

  it("resolves base (merge-base with main) and head, and reports a clear error otherwise", async () => {
    const { repo, base, head } = makeRepo();
    const r = await resolveRange(repo, undefined, "HEAD");
    expect(r.baseSha).toBe(base);
    expect(r.headSha).toBe(head);
    expect((await resolveRange(repo, "main", "feature")).baseSha).toBe(base);
    await expect(resolveRange(repo, "nope", "HEAD")).rejects.toThrow(/--base/);
    await expect(resolveRange(repo, undefined, "nope")).rejects.toThrow(/--head/);

    const lone = mkdtempSync(path.join(os.tmpdir(), "guardrails-review-"));
    dirs.push(lone);
    git(lone, "init", "-q", "-b", "topic");
    writeFileSync(path.join(lone, "x.txt"), "x");
    git(lone, "add", "-A");
    git(lone, "commit", "-q", "-m", "x");
    await expect(resolveRange(lone, undefined, "HEAD")).rejects.toThrow(/Pass --base/);
  });

  it("returns 2 for a path that is not a git repository and 0 when there is nothing to review", async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "guardrails-plain-"));
    dirs.push(plain);
    const c = io();
    expect(await runReview(opts(plain, undefined), c.handle)).toBe(2);
    expect(c.err.join("\n")).toContain("not a git repository");

    const { repo } = makeRepo();
    const model = modelReporting([finding()]);
    expect(await runReview(opts(repo, model, { base: "HEAD" }), io().handle)).toBe(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("returns 3 when the budget cuts the run", async () => {
    const { repo } = makeRepo();
    const big = { ...usage, inputTokens: { total: 5_000_000, noCache: 5_000_000, cacheRead: 0, cacheWrite: 0 } };
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ ...report([finding()]), usage: big }) });
    // Mock models have no known price, so the cap is applied on tokens (budget 0.5 USD ~ 500k tokens).
    const code = await runReview(opts(repo, model, { budgetUsd: 0.5 }), io().handle);
    expect(code).toBe(3);
  });
});

describe("parseReviewArgs", () => {
  it("applies defaults and validates flags", () => {
    const o = parseReviewArgs([]);
    expect(o).toMatchObject({ path: ".", head: "HEAD", mode: "agent", failOn: "high", dryRun: false, json: false });
    expect(parseReviewArgs(["--fail-on", "none", "--budget-usd", "0.4"])).toMatchObject({ failOn: "none", budgetUsd: 0.4 });
    expect(() => parseReviewArgs(["--fail-on", "x"])).toThrow();
    expect(() => parseReviewArgs(["--mode", "x"])).toThrow();
    expect(() => parseReviewArgs(["--budget-usd", "-1"])).toThrow();
  });
});

describe("guardrails review: coverage", () => {
  it("human output prints the coverage line; --details adds the block", async () => {
    const { repo } = makeRepo();
    const plain = io();
    await runReview(opts(repo, modelReporting([finding()])), plain.handle);
    const text = plain.out.join("\n");
    expect(text).toMatch(/Coverage: (complete|partial \(.*\)) · \d+ of \d+ changed files? reviewed/);
    expect(text).not.toContain("<details>");

    const detailed = io();
    await runReview(opts(repo, modelReporting([finding()]), { details: true }), detailed.handle);
    const full = detailed.out.join("\n");
    expect(full).toContain("<details><summary>What was reviewed</summary>");
    expect(full).toContain("| `src/a.ts` |");
    expect(full).toContain("**check** = exact result of code");
  });

  it("--json carries the coverage object", async () => {
    const { repo } = makeRepo();
    const c = io();
    await runReview(opts(repo, modelReporting([finding()]), { json: true }), c.handle);
    const json = JSON.parse(c.out.join("\n"));
    expect(json.coverage).toMatchObject({ files: { total: expect.any(Number) }, engine: { mode: "agent" } });
    expect(Array.isArray(json.coverage.reasons)).toBe(true);
  });

  it("parses --details", () => {
    expect(parseReviewArgs(["--details"])).toMatchObject({ details: true });
    expect(parseReviewArgs([])).toMatchObject({ details: false });
  });
});
