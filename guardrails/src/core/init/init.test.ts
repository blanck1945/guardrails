import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRulesMd, serializeRulesMd } from "../rules";
import { LocalWorkspace, type ListFilesInput, type ReadFileInput, type Workspace } from "../workspace";
import { collectRepoContext, INIT_LIMITS } from "./collect";
import { filterCandidates } from "./filter";
import { formatInitReport, InitTimeoutError, runInit } from "./run";
import { validateScopes } from "./scopes";
import { isSecretPath, redactSecrets } from "./secrets";
import { GROUP_MAX_CHARS, groupFiles, INIT_MAX_OUTPUT_TOKENS, InitOutputCapError, MAX_CANDIDATES, mergeGroupCandidates, normalizeCandidates, synthesizeRules, type CandidateRule } from "./synthesize";
import { mergeSuggestions } from "./write";

const SECRET_VALUE = "sk-live-SUPERSECRETVALUE1234567890abcdef";
const CLAUDE_MD = `# Project rules
- Everything in English: code, comments, commits and docs.
- Never hardcode domains; read them from config.
- Never hand-patch generated apps; fix the generator.
- No product UI in panel/public/.
- Do not add git URLs to seeds.config.json without verifying them.
`;

let tmp: string;
let repo: string;
let ws: LocalWorkspace;

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}
const put = (rel: string, content: string) => {
  const p = path.join(repo, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
};

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "init-test-"));
  repo = path.join(tmp, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  put("CLAUDE.md", CLAUDE_MD);
  put("README.md", "# Starter\nSee CLAUDE.md.\n");
  put("docs/lessons.md", "# Lessons\n- Never combine overflow-x: hidden with overflow-y: visible.\n");
  put(".oxlintrc.json", '{ "rules": { "react-hooks/rules-of-hooks": "error", "consistent-type-imports": "error" } }\n');
  put("tsconfig.json", '{ "compilerOptions": { "strict": true, "erasableSyntaxOnly": true } }\n');
  put(".github/workflows/ci.yml", "jobs:\n  ci:\n    steps:\n      - run: pnpm lint\n      - run: pnpm tsc --noEmit\n");
  put("seeds.config.json", "{}\n");
  put("src/app.ts", "export const x = 1;\n");
  put("panel/public/index.html", "<html></html>\n");
  put(".env", `API_KEY=${SECRET_VALUE}\n`);
  put("config/server.pem", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
  put("dist/CLAUDE.md", "ignored build output\n");
  put("pnpm-lock.yaml", "lock\n");
  // `-f` because a .gitignore-less repo tracks everything anyway; .env and .pem are deliberately tracked.
  git(repo, "add", "-A", "-f");
  git(repo, "commit", "-q", "-m", "init");
  ws = new LocalWorkspace({ root: repo });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const cand = (over: Partial<CandidateRule> & { id: string }): CandidateRule => ({
  rule: `Rule text for ${over.id}`,
  scope: ["**"],
  severity: "medium",
  source: "CLAUDE.md",
  confidence: 0.9,
  kind: "diff-checkable",
  ...over,
});

describe("collectRepoContext", () => {
  it("finds docs, lint configs and CI, and builds a structure summary", async () => {
    const ctx = await collectRepoContext(ws);
    const paths = ctx.files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["CLAUDE.md", "docs/lessons.md", ".oxlintrc.json", "tsconfig.json", ".github/workflows/ci.yml", "README.md"]),
    );
    expect(ctx.files.find((f) => f.path === "CLAUDE.md")!.content).toContain("Never hardcode domains");
    // priority order: instructions before readme
    expect(paths.indexOf("CLAUDE.md")).toBeLessThan(paths.indexOf("README.md"));
    expect(ctx.structure).toContain("src/");
    expect(ctx.structure).toContain("panel/");
    expect(ctx.totalChars).toBeLessThanOrEqual(INIT_LIMITS.maxTotalChars);
  });

  it("never reads ignored or secret files and never puts their content in the context", async () => {
    const ctx = await collectRepoContext(ws);
    const paths = ctx.files.map((f) => f.path);
    expect(paths).not.toContain("dist/CLAUDE.md");
    expect(paths.some((p) => isSecretPath(p))).toBe(false);
    const blob = JSON.stringify(ctx);
    expect(blob).not.toContain(SECRET_VALUE);
    expect(blob).not.toContain("BEGIN PRIVATE KEY");
    expect(ctx.structure).not.toContain(".env");
    expect(ctx.structure).not.toContain("server.pem");
  });

  it("does not read secret files even if the workspace lists them (no-regression)", async () => {
    const reads: string[] = [];
    const hostile: Workspace = {
      ...ws,
      listFiles: async (i?: ListFilesInput) => ({
        files: [".env", ".env.production", "config/server.pem", ".ssh/id_rsa", "secrets.json", "CLAUDE.md"],
        truncated: !!i && false,
      }),
      readFile: async (i: ReadFileInput) => {
        reads.push(i.path);
        return {
          path: i.path,
          ref: "head" as const,
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          content: i.path === "CLAUDE.md" ? `1\tsafe text with token ${SECRET_VALUE}` : `1\t${SECRET_VALUE}`,
          truncated: false,
        };
      },
      grep: ws.grep.bind(ws),
      diff: ws.diff.bind(ws),
      findReferencesByName: ws.findReferencesByName.bind(ws),
    };
    const ctx = await collectRepoContext(hostile);
    expect(new Set(reads)).toEqual(new Set(["CLAUDE.md"]));
    expect(JSON.stringify(ctx)).not.toContain(SECRET_VALUE); // redacted even inside allowed files
    expect(ctx.skipped.map((s) => s.reason)).toContain("secret");
  });

  it("truncates big files at the per-file cap", async () => {
    const big = "x".repeat(50) + "\n";
    put("CONTRIBUTING.md", big.repeat(1000));
    git(repo, "add", "-A", "-f");
    git(repo, "commit", "-q", "-m", "big");
    const ctx = await collectRepoContext(ws);
    const f = ctx.files.find((x) => x.path === "CONTRIBUTING.md")!;
    expect(f.truncated).toBe(true);
    expect(f.content.length).toBeLessThanOrEqual(INIT_LIMITS.maxFileChars);
  });
});

describe("secrets helpers", () => {
  it("detects secret paths and redacts secret-looking strings", () => {
    for (const p of [".env", ".env.local", "a/b/.env.production", "k.pem", "id_rsa", ".npmrc", ".aws/credentials", "secrets.yaml"]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    for (const p of ["CLAUDE.md", "src/env.ts", "docs/secret-santa.md", "tsconfig.json"]) expect(isSecretPath(p), p).toBe(false);
    const r = redactSecrets(`token ghp_${"a".repeat(36)} and AWS_SECRET_KEY=abcd1234efgh and ${SECRET_VALUE}`);
    expect(r).not.toMatch(/ghp_a{36}|abcd1234efgh|SUPERSECRET/);
  });
});

describe("synthesizeRules", () => {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
  const mockModel = (rules: unknown[], onCall?: (prompt: string) => void) =>
    new MockLanguageModelV4({
      doGenerate: async (o) => {
        onCall?.(JSON.stringify(o.prompt));
        return {
          content: [{ type: "text", text: JSON.stringify({ rules }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

  it("returns normalized candidates and sends the collected context (untrusted-wrapped)", async () => {
    const ctx = await collectRepoContext(ws);
    let seen = "";
    const model = mockModel(
      [
        { id: "English Only!", rule: "All code in English.", scope: ["/src/**", "../etc"], severity: "high", source: "CLAUDE.md", confidence: 0.95, kind: "diff-checkable" },
        { id: "strict-ts", rule: "Enable strict.", scope: [], severity: "low", source: "tsconfig.json", confidence: 0.9, kind: "tool-enforced" },
      ],
      (p) => (seen = p),
    );
    const r = await synthesizeRules(ctx, { model });
    expect(r.candidates.map((c) => c.id)).toEqual(["english-only", "strict-ts"]);
    expect(r.candidates[0]!.scope).toEqual(["src/**"]);
    expect(r.candidates[1]!.scope).toEqual(["**"]);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(seen).toContain("<untrusted>");
    expect(seen).toContain("Never hardcode domains");
    expect(seen).not.toContain(SECRET_VALUE);
  });

  it("skips the model call when nothing was collected", async () => {
    const r = await synthesizeRules({ files: [], structure: "", skipped: [], totalChars: 0 }, { model: mockModel([]) });
    expect(r.candidates).toEqual([]);
  });

  it("candidates default to type style and mergeSuggestions writes the type", () => {
    const [n] = normalizeCandidates([cand({ id: "a" }), cand({ id: "sec", type: "security" })]);
    expect(n!.type).toBe("style");
    const { added, text } = mergeSuggestions(null, [cand({ id: "sec", type: "security" }), cand({ id: "plain" })]);
    expect(added.map((r) => r.type)).toEqual(["security", "style"]);
    expect(parseRulesMd(text).rules.map((r) => r.type)).toEqual(["security", "style"]);
  });

  it("normalizeCandidates dedupes ids and drops empty rules", () => {
    const out = normalizeCandidates([cand({ id: "a" }), cand({ id: "a" }), cand({ id: "b", rule: "  " }), cand({ id: "c", confidence: 3 })]);
    expect(out.map((c) => c.id)).toEqual(["c", "a", "a-2"]); // highest confidence first
    expect(out[0]!.confidence).toBe(1);
  });
});

describe("filterCandidates", () => {
  const list = [
    cand({ id: "keep" }),
    cand({ id: "ctx", kind: "context-only", confidence: 0.7 }),
    cand({ id: "tool", kind: "tool-enforced" }),
    cand({ id: "weak", confidence: 0.3 }),
  ];
  it("drops tool-enforced and low confidence by default, listing them apart", () => {
    const f = filterCandidates(list);
    expect(f.kept.map((c) => c.id)).toEqual(["keep", "ctx"]);
    expect(f.toolEnforced.map((c) => c.id)).toEqual(["tool"]);
    expect(f.lowConfidence.map((c) => c.id)).toEqual(["weak"]);
  });
  it("threshold and tool-enforced inclusion are configurable", () => {
    expect(filterCandidates(list, { minConfidence: 0.2 }).kept.map((c) => c.id)).toEqual(["keep", "ctx", "weak"]);
    expect(filterCandidates(list, { includeToolEnforced: true }).kept.map((c) => c.id)).toContain("tool");
  });
});

describe("mergeSuggestions", () => {
  it("creates a file with suggested rules that parse cleanly", () => {
    const r = mergeSuggestions(null, [cand({ id: "english-only", source: "CLAUDE.md" })]);
    const parsed = parseRulesMd(r.text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.rules[0]).toMatchObject({ id: "english-only", status: "suggested", source: "CLAUDE.md" });
  });

  it("never overwrites user rules: existing text stays byte-for-byte and repeated ids are skipped", () => {
    const existing = serializeRulesMd(
      [
        { id: "english-only", rule: "MY OWN WORDING", scope: ["src/**"], severity: "high", source: "user", status: "active" },
        { id: "old-off", rule: "was disabled", scope: ["**"], severity: "low", source: "user", status: "disabled" },
      ],
      { preamble: "# my notes" },
    ) + "\n## broken_id\nnot parseable\n";
    const r = mergeSuggestions(existing, [
      cand({ id: "english-only", rule: "generated wording" }),
      cand({ id: "old-off", rule: "again" }),
      cand({ id: "broken_id", rule: "x" }),
      cand({ id: "same-text", rule: "MY   own wording" }),
      cand({ id: "new-one", source: "user" }),
    ]);
    expect(r.text.startsWith(existing.replace(/\s+$/, ""))).toBe(true);
    expect(r.skipped.map((s) => [s.id, s.reason])).toEqual([
      ["english-only", "id-exists"],
      ["old-off", "id-exists"],
      ["broken_id", "id-exists"],
      ["same-text", "duplicate-text"],
    ]);
    const parsed = parseRulesMd(r.text);
    const byId = Object.fromEntries(parsed.rules.map((x) => [x.id, x]));
    expect(byId["english-only"]).toMatchObject({ rule: "MY OWN WORDING", status: "active", source: "user" });
    expect(byId["new-one"]).toMatchObject({ status: "suggested", source: "inferred" });
    expect(byId["broken_id"]).toBeUndefined();
    expect(r.added.map((x) => x.id)).toEqual(["new-one"]);
  });

  it("skips ids that exist in config.json rules or disabledRules, and is idempotent", () => {
    const c = [cand({ id: "in-config" }), cand({ id: "muted" }), cand({ id: "fresh" })];
    const opts = {
      configRules: [{ id: "in-config", rule: "x", scope: ["**"], severity: "low" as const, status: "active" as const }],
      disabledRules: ["muted"],
    };
    const first = mergeSuggestions(null, c, opts);
    expect(first.added.map((x) => x.id)).toEqual(["fresh"]);
    const second = mergeSuggestions(first.text, c, opts);
    expect(second.added).toEqual([]);
    expect(second.text).toBe(first.text);
  });
});

describe("runInit (mock model, fixture repo)", () => {
  it("collects, drops tool-enforced rules and only suggests the rest", async () => {
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    };
    const rules = [
      cand({ id: "english-only", rule: "Everything in English.", source: "CLAUDE.md" }),
      cand({ id: "no-product-ui-in-panel-public", rule: "No product UI in panel/public/.", scope: ["panel/public/**"], severity: "high", source: "CLAUDE.md" }),
      cand({ id: "hooks-rules", rule: "Follow the rules of hooks.", source: ".oxlintrc.json", kind: "tool-enforced" }),
    ];
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ rules }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const r = await runInit({ workspace: ws, model });
    expect(r.filtered.toolEnforced.map((c) => c.id)).toEqual(["hooks-rules"]);
    expect(r.merge.added.map((x) => x.id)).toEqual(["english-only", "no-product-ui-in-panel-public"]);
    const parsed = parseRulesMd(r.merge.text);
    expect(parsed.rules.every((x) => x.status === "suggested")).toBe(true);
  });
});

describe("validateScopes (against tracked files)", () => {
  const files = ["seeds.config.json", ".claude/settings.json", "src/a.ts", "src/b.tsx", "docs/lessons.md", "docs/lessons-old.md", "app.config.json", "app.config.mjs"];
  const ids = (r: ReturnType<typeof validateScopes>) => r.candidates.map((c) => c.scope);

  it("leaves valid globs (and rules) untouched", () => {
    const input = [cand({ id: "ts", scope: ["src/**/*.ts", "*.tsx"] }), cand({ id: "all" }), cand({ id: "exact", scope: ["seeds.config.json"] })];
    const r = validateScopes(input, files);
    expect(r.scopeWarnings).toEqual([]);
    expect(r.candidates[0]).toBe(input[0]);
    expect(r.candidates[2]).toBe(input[2]);
  });

  it("repairs a prefix that identifies exactly one file, in scope and rule text", () => {
    const r = validateScopes(
      [cand({ id: "s", scope: ["seeds.config.", ".claude/settings."], rule: "Keep .claude/settings. and seeds.config., never seeds.config.jsonx." })],
      files,
    );
    expect(ids(r)).toEqual([["seeds.config.json", ".claude/settings.json"]]);
    expect(r.candidates[0]!.rule).toBe("Keep .claude/settings.json and seeds.config.json, never seeds.config.jsonx.");
    expect(r.scopeWarnings[0]).toMatchObject({ id: "s", dropped: [], noValidScope: false });
    expect(r.scopeWarnings[0]!.repaired).toEqual([
      { from: "seeds.config.", to: "seeds.config.json" },
      { from: ".claude/settings.", to: ".claude/settings.json" },
    ]);
    expect(r.candidates[0]!.confidence).toBe(0.9);
  });

  it("does not repair an ambiguous prefix: drops it", () => {
    const r = validateScopes([cand({ id: "amb", scope: ["app.config.", "src/**/*.ts"] })], files);
    expect(ids(r)).toEqual([["src/**/*.ts"]]);
    expect(r.scopeWarnings[0]).toMatchObject({ dropped: ["app.config."], repaired: [], noValidScope: false });
    const lessons = validateScopes([cand({ id: "l", scope: ["docs/lessons"] })], files); // matches lessons.md and lessons-old.md
    expect(lessons.scopeWarnings[0]!.dropped).toEqual(["docs/lessons"]);
  });

  it("drops a glob with no matches; a rule left without scope falls back to ** with lower confidence", () => {
    const r = validateScopes([cand({ id: "dead", scope: ["panel/public/**", "nothing.*"], confidence: 0.8 })], files);
    expect(ids(r)).toEqual([["**"]]);
    expect(r.candidates[0]!.confidence).toBeCloseTo(0.4);
    expect(r.scopeWarnings[0]).toMatchObject({ id: "dead", dropped: ["panel/public/**", "nothing.*"], noValidScope: true });
  });

  it("does nothing without a file list", () => {
    const input = [cand({ id: "x", scope: ["nope/**"] })];
    expect(validateScopes(input, []).candidates[0]).toBe(input[0]);
  });
});

describe("runInit scope validation (mock model)", () => {
  it("repairs truncated names and reports dead-glob rules instead of suggesting them", async () => {
    const rules = [
      cand({ id: "seeds", rule: "In seeds.config., add only verified URLs.", scope: ["seeds.config."], confidence: 0.9 }),
      cand({ id: "dead", rule: "Dead glob.", scope: ["no/such/**"], confidence: 0.7 }),
    ];
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify({ rules }) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    });
    const r = await runInit({ workspace: ws, model });
    expect(r.merge.added.map((x) => [x.id, x.scope])).toEqual([["seeds", ["seeds.config.json"]]]);
    expect(r.merge.added[0]!.rule).toContain("seeds.config.json");
    expect(r.scopeWarnings.map((w) => w.id)).toEqual(["seeds", "dead"]);
    expect(r.filtered.lowConfidence.map((c) => c.id)).toEqual(["dead"]);
    expect(formatInitReport(r, { write: false, rulesPath: "x" })).toContain("Scope warnings");
  });
});

describe("init limits: rule cap, output cap, timeout, progress", () => {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
  const okModel = (rules: unknown[], onOptions?: (o: { maxOutputTokens?: number }) => void) =>
    new MockLanguageModelV4({
      doGenerate: async (options) => {
        onOptions?.(options as { maxOutputTokens?: number });
        return { content: [{ type: "text", text: JSON.stringify({ rules }) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      },
    });

  it("keeps at most MAX_CANDIDATES rules, highest confidence first", () => {
    const many = Array.from({ length: 25 }, (_, i) => cand({ id: `rule-${i}`, confidence: i === 24 ? 0.99 : 0.5 + i / 100 }));
    const out = normalizeCandidates(many);
    expect(out).toHaveLength(MAX_CANDIDATES);
    expect(MAX_CANDIDATES).toBeLessThanOrEqual(15);
    expect(out[0]!.id).toBe("rule-24");
    expect(out.map((c) => c.confidence)).toEqual([...out.map((c) => c.confidence)].sort((a, b) => b - a));
  });

  it("passes a bounded maxOutputTokens to the model", async () => {
    let seen: number | undefined;
    await synthesizeRules(await collectRepoContext(ws), { model: okModel([], (o) => (seen = o.maxOutputTokens)) });
    expect(seen).toBe(INIT_MAX_OUTPUT_TOKENS);
    await synthesizeRules(await collectRepoContext(ws), { model: okModel([], (o) => (seen = o.maxOutputTokens)), maxOutputTokens: 1234 });
    expect(seen).toBe(1234);
  });

  it("reports a clear error when the output cap is hit before any answer", async () => {
    const truncated = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [], finishReason: { unified: "length", raw: undefined }, usage, warnings: [] }),
    });
    await expect(synthesizeRules(await collectRepoContext(ws), { model: truncated, maxOutputTokens: 50 })).rejects.toThrow(InitOutputCapError);
  });

  it("aborts a slow model at the timeout with a clear error", async () => {
    const slow = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) =>
        new Promise((_, reject) => {
          if (abortSignal?.aborted) return reject(abortSignal.reason ?? new Error("aborted"));
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason ?? new Error("aborted")));
        }),
    });
    const t0 = Date.now();
    const err = await runInit({ workspace: ws, model: slow, timeoutSec: 0.2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InitTimeoutError);
    expect((err as Error).message).toMatch(/timed out after 0\.2s.*"synthesize"/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("reports progress per stage with timings", async () => {
    const stages: string[] = [];
    await runInit({ workspace: ws, model: okModel([cand({ id: "one" })]), onProgress: (s, i) => stages.push(`${s}:${typeof i.ms}`) });
    expect(stages).toEqual(["collect:number", "synthesize:number", "filter:number"]);
  });
});

describe("parallel synthesis by source groups", () => {
  const f = (path: string, n: number) => ({ path, kind: "instructions" as const, content: "x".repeat(n), truncated: false });
  it("groupFiles packs in order, isolates big files and caps the group count", () => {
    expect(groupFiles([f("a", 100), f("b", 100)], 1000).map((g) => g.length)).toEqual([2]);
    expect(groupFiles([f("a", 600), f("b", 600), f("c", 100)], 1000).map((g) => g.map((x) => x.path))).toEqual([["a"], ["b", "c"]]);
    const many = Array.from({ length: 9 }, (_, i) => f(`f${i}`, 900));
    expect(groupFiles(many, 1000, 4)).toHaveLength(4);
  });

  it("mergeGroupCandidates dedupes by id (best confidence wins) and caps", () => {
    const out = mergeGroupCandidates([
      [cand({ id: "english-only", confidence: 0.7 }), cand({ id: "b", confidence: 0.8 })],
      [cand({ id: "English Only", confidence: 0.95, rule: "better" })],
    ]);
    expect(out.map((c) => c.id)).toEqual(["english-only", "b"]);
    expect(out[0]!.rule).toBe("better");
  });

  it("one call per group, sources split, results merged", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const text = JSON.stringify(options.prompt);
        prompts.push(text);
        const id = text.includes("AAAA") ? "from-a" : "from-b";
        return {
          content: [{ type: "text", text: JSON.stringify({ rules: [cand({ id, rule: `rule ${id}` })] }) }],
          finishReason: { unified: "stop", raw: undefined },
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
          warnings: [],
        };
      },
    });
    const ctx = {
      files: [
        { path: "A.md", kind: "instructions" as const, content: "AAAA" + "x".repeat(GROUP_MAX_CHARS), truncated: false },
        { path: "B.md", kind: "readme" as const, content: "BBBB" + "y".repeat(GROUP_MAX_CHARS), truncated: false },
      ],
      structure: "Root files: A.md, B.md",
      skipped: [],
      totalChars: 2 * GROUP_MAX_CHARS,
    };
    const r = await synthesizeRules(ctx, { model });
    expect(prompts).toHaveLength(2);
    expect(prompts.filter((p) => p.includes("AAAA") && p.includes("BBBB"))).toHaveLength(0);
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["from-a", "from-b"]);
    expect(r.usage.inputTokens).toBe(20);
  });
});
