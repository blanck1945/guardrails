import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewArgs, runReview, type CliIO, type ReviewCliOptions } from "./review";

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const emptyReport = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "tool-call", toolCallId: "r1", toolName: "report_findings", input: JSON.stringify({ findings: [] }) }],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage,
      warnings: [],
    }),
  });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

/** Base has the config (`language` chosen by the test) and a rule with a check; the feature adds a file without a test. */
function makeRepo(configLanguage?: string) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "guardrails-lang-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(path.join(repo, ".guardrails"));
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, ".guardrails/rules.md"), "# Rules\n\n## tests\nscope: src/**\nseverity: medium\ncheck: colocated-test\nstatus: active\n\nEvery module has a test.\n");
  writeFileSync(path.join(repo, ".guardrails/config.json"), JSON.stringify(configLanguage ? { language: configLanguage } : {}));
  writeFileSync(path.join(repo, "src/keep.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(path.join(repo, "src/Badge.tsx"), "export function Badge(a: number) {\n  return a + 1;\n}\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature");
  return repo;
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const handle: CliIO = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return { handle, out, err };
}
const opts = (repo: string, over: Partial<ReviewCliOptions> = {}): ReviewCliOptions => ({ path: repo, base: "main", head: "HEAD", mode: "agent", model: emptyReport(), dryRun: false, yes: true, json: false, failOn: "none", interactive: false, details: true, ...over });

describe("--language", () => {
  it("parses en and es, rejects anything else, and is optional", () => {
    expect(parseReviewArgs(["--language", "es"]).language).toBe("es");
    expect(parseReviewArgs(["--language", "en"]).language).toBe("en");
    expect(parseReviewArgs([]).language).toBeUndefined();
    expect(() => parseReviewArgs(["--language", "fr"])).toThrow(/--language must be en or es/);
  });

  it("without the flag the config language of the base commit applies; English by default", { timeout: 60_000 }, async () => {
    const def = io();
    await runReview(opts(makeRepo()), def.handle);
    const t = def.out.join("\n");
    expect(t).toContain("Missing test file: Badge.tsx has no test next to it");
    expect(t).toContain("Coverage:");
    expect(t).toContain("Cost:");

    const cfg = io();
    await runReview(opts(makeRepo("es")), cfg.handle);
    const s = cfg.out.join("\n");
    expect(s).toContain("Falta el archivo de test: Badge.tsx no tiene un test al lado");
    expect(s).toContain("Agrega src/Badge.test.tsx.");
    expect(s).toContain("Regla tests");
    expect(s).toContain("Cobertura:");
    expect(s).toContain("Costo:");
    expect(s).toContain("<summary>Qué se revisó</summary>");
  });

  it("--language overrides the config in both directions", { timeout: 60_000 }, async () => {
    const a = io();
    await runReview(opts(makeRepo("en"), { language: "es" }), a.handle);
    expect(a.out.join("\n")).toContain("Falta el archivo de test");
    const b = io();
    await runReview(opts(makeRepo("es"), { language: "en" }), b.handle);
    expect(b.out.join("\n")).toContain("Missing test file");
  });

  it("--json keeps its keys and rule ids whatever the language", { timeout: 60_000 }, async () => {
    const en = io();
    await runReview(opts(makeRepo(), { json: true, language: "en" }), en.handle);
    const es = io();
    await runReview(opts(makeRepo(), { json: true, language: "es" }), es.handle);
    const a = JSON.parse(en.out.join("\n"));
    const b = JSON.parse(es.out.join("\n"));
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.findings[0]).toMatchObject({ ruleId: "tests", origin: "check", file: "src/Badge.tsx" });
    expect(b.findings[0]).toMatchObject({ ruleId: "tests", origin: "check", file: "src/Badge.tsx" });
    expect(b.findings[0].title).toContain("Falta el archivo de test");
  });
});
