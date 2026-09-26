import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/core/workspace";
import { RepoTooLargeError } from "@/core/workspace";
import { packDiff } from "./diff-pack";
import { MAX_DIFF_CHARS, reviewPullRequest, type DisposableWorkspace, type ReviewPrDeps } from "./review-pr";
import type { PullRequestEvent } from "./webhook";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const toolCall = (toolName: string, input: unknown, id = "r1"): GenResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
const textResult = (text: string): GenResult => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] });

const ev: PullRequestEvent = {
  installationId: 1,
  owner: "o",
  repo: "r",
  number: 7,
  headSha: "headsha",
  baseSha: "basesha",
  action: "opened",
  draft: false,
  isFork: false,
  labels: [],
  senderLogin: "dev",
  senderType: "User",
};

const TEN = ["@@ -1,1 +1,11 @@", " export function f() {", ...Array.from({ length: 10 }, (_, i) => `+  const v${i} = ${i};`)].join("\n");
const SMALL = "@@ -1,2 +1,3 @@\n export function f() {\n+  const x = 1;\n }";
/** A patch of about `chars` characters made only of added lines; the line `todoAt` (1-based) holds a TODO comment. */
function bigPatch(chars: number, todoAt: number): string {
  const n = Math.ceil(chars / 100);
  const rows = Array.from({ length: n }, (_, i) => (i + 1 === todoAt ? "+// TODO fix this later" : `+${"x".repeat(99)}`));
  return [`@@ -0,0 +1,${n} @@`, ...rows].join("\n");
}

const RULES_MD = "## no-todo\nscope: **\nseverity: low\ncheck: forbid-pattern: TODO\ncheck-coverage: exhaustive\nstatus: active\n\nNo TODO comments.\n\n## english-only\nscope: src/**\nseverity: low\nstatus: active\n\nEnglish only.\n\n## other-scope\nscope: docs/**\nstatus: active\n\nOnly docs.\n";

type F = { filename: string; status: string; patch?: string };
function fakeOcto(files: F[], repoFiles: Record<string, string> = {}, labels: string[] = []) {
  const createReview = vi.fn(async (_: unknown) => ({}));
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    const c = repoFiles[path];
    if (c !== undefined) return { data: { type: "file", content: Buffer.from(c).toString("base64") } };
    throw Object.assign(new Error("not found"), { status: 404 });
  });
  const octo = {
    rest: {
      pulls: { get: async () => ({ data: { title: "t", body: "d", base: { sha: "basesha" }, head: { sha: "headsha" }, labels: labels.map((name) => ({ name })) } }), listFiles: vi.fn(), createReview },
      repos: { getContent },
    },
    paginate: async () => files,
  };
  return { octo, createReview };
}
const fakeWs = (): DisposableWorkspace =>
  ({
    readFile: async (i) => ({ path: i.path, ref: i.ref ?? "head", startLine: 1, endLine: 1, totalLines: 1, content: "1\tx", truncated: false }),
    grep: async () => ({ matches: [], truncated: false }),
    listFiles: async () => ({ files: [], truncated: false }),
    diff: async () => "",
    findReferencesByName: async () => ({ references: [], truncated: false }),
    dispose: async () => {},
  }) satisfies Workspace & { dispose(): Promise<void> };

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());
const events = (name: string) => logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === name);

function run(files: F[], opts: { repoFiles?: Record<string, string>; model?: MockLanguageModelV4; deps?: Partial<ReviewPrDeps>; labels?: string[] } = {}) {
  const o = fakeOcto(files, opts.repoFiles, opts.labels);
  const model = opts.model ?? new MockLanguageModelV4({ doGenerate: async () => toolCall("report_findings", { findings: [], ruleChecks: [{ ruleId: "english-only", verdict: "ok" }, { ruleId: "no-todo", verdict: "ok" }] }) });
  const deps: ReviewPrDeps = { octokit: async () => o.octo as never, createWorkspace: async () => fakeWs(), env: {}, model, ...opts.deps };
  const done = reviewPullRequest({ ...ev, labels: opts.labels ?? [] }, deps);
  const review = async () => {
    await done;
    return o.createReview.mock.calls[0]![0] as { body: string; comments: { path: string; line: number; body: string }[] };
  };
  return { review, model, o };
}

describe("packDiff", () => {
  const f = (name: string, size: number) => ({ filename: name, patch: "x".repeat(size) });
  it("packs whole files in PR order and keeps trying later small files after one that does not fit", () => {
    const p = packDiff([f("a", 100), f("big", 1000), f("b", 100)], 400);
    expect(p.included).toEqual(["a", "b"]);
    expect(p.overBudget).toEqual(["big"]);
    expect(p.diff.length).toBeLessThanOrEqual(400);
    expect(p.diff).not.toContain("big");
  });
  it("never cuts a file in the middle: every included file is complete", () => {
    const files = [f("a", 150), f("b", 150), f("c", 150)];
    const p = packDiff(files, 400);
    for (const name of p.included) expect(p.diff).toContain(`+++ b/${name}\n${"x".repeat(150)}`);
    expect(p.included.length + p.overBudget.length).toBe(3);
  });
  it("everything fits: the diff equals the full text", () => {
    const p = packDiff([f("a", 10), f("b", 10)], 1000);
    expect(p.overBudget).toEqual([]);
    expect(p.diff).toBe("--- a/a\n+++ b/a\n" + "x".repeat(10) + "\n--- a/b\n+++ b/b\n" + "x".repeat(10));
  });
});

describe("reviewPullRequest: coverage in the summary", () => {
  it("reports removed, ignored, patch-less and over-budget files with their state, and never cuts a file", async () => {
    const files: F[] = [
      { filename: "src/a.ts", status: "modified", patch: SMALL },
      { filename: "src/gone.ts", status: "removed", patch: SMALL },
      { filename: "pnpm-lock.yaml", status: "modified", patch: SMALL },
      { filename: "assets/logo.png", status: "added" },
      { filename: "src/big.ts", status: "added", patch: bigPatch(MAX_DIFF_CHARS + 5000, 300) },
      { filename: "src/late.ts", status: "modified", patch: SMALL },
    ];
    const t = run(files, { repoFiles: { ".guardrails/rules.md": RULES_MD, "src/a.ts": "x" } });
    const { body, comments } = await t.review();
    expect(body).toMatch(/Coverage: partial \(1 file over the diff budget\) · 2 of 6 changed files reviewed \(1 ignored, 1 removed, 1 without diff, 1 over budget\)/);
    expect(body).toContain("| `pnpm-lock.yaml` | ignored (default) |");
    expect(body).toContain("| `src/gone.ts` | removed |");
    expect(body).toContain("| `assets/logo.png` | no diff (binary or too large) |");
    expect(body).toContain("| `src/big.ts` | over the diff budget · checks ran |");
    expect(body).toContain("| `src/late.ts` | reviewed |");
    // the model prompt has every file that fit whole and no part of the big one
    const prompt = JSON.stringify(t.model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("src/late.ts");
    expect(prompt).not.toContain("src/big.ts");
    expect(prompt).not.toContain("xxxxxxxxxxxxxxxxxxxx");
    // the check still reports the violation in the file that did not fit
    expect(comments.map((c) => `${c.path}:${c.line}`)).toContain("src/big.ts:300");
    expect(body).toMatch(/\| `no-todo` \| check \| 1 violation \|/);
    expect(body).toContain("1 other active rule out of scope.");
    const e = events("review.analyzed")[0]!;
    expect(e).toMatchObject({ filesChanged: 6, filesReviewed: 2, filesIgnored: 1, filesRemoved: 1, filesNoDiff: 1, filesOverBudget: 1, coverageComplete: false, coverageReasons: ["diff-over-budget"], rulesInScope: 2, rulesByCheck: 1, rulesByModel: 1 });
  });

  it("log fields are counters and codes only", async () => {
    const t = run([{ filename: "src/a.ts", status: "modified", patch: SMALL }], { repoFiles: { ".guardrails/rules.md": RULES_MD } });
    await t.review();
    const e = events("review.analyzed")[0]!;
    for (const k of ["filesChanged", "filesReviewed", "filesIgnored", "filesRemoved", "filesNoDiff", "filesOverBudget", "filesChecksOnly", "filesOpened", "rulesInScope", "rulesByCheck", "rulesByModel", "rulesWithVerdict", "verdictConflicts", "coverageComplete", "coverageReasons"]) expect(e).toHaveProperty(k);
    expect(JSON.stringify(e)).not.toContain("src/a.ts");
    expect(e.coverageReasons).toEqual([]);
  });

  it("a fallback to single mode is visible in the summary", async () => {
    const single = new MockLanguageModelV4({ doGenerate: async () => textResult(JSON.stringify({ summary: "s", findings: [] })) });
    const t = run([{ filename: "src/a.ts", status: "modified", patch: SMALL }], {
      model: single,
      deps: { createWorkspace: async () => { throw new RepoTooLargeError("bytes", 1); } },
    });
    const { body } = await t.review();
    expect(body).toContain("Coverage: partial (repo too large: single-call review)");
    expect(events("review.analyzed")[0]).toMatchObject({ coverageComplete: false, coverageReasons: ["single-fallback"] });
  });

  it("config coverage is read from the base: line prints only the line, off prints nothing", async () => {
    const files: F[] = [{ filename: "src/a.ts", status: "modified", patch: SMALL }];
    const line = await run(files, { repoFiles: { ".guardrails/config.json": JSON.stringify({ coverage: "line" }) } }).review();
    expect(line.body).toContain("Coverage: complete");
    expect(line.body).not.toContain("<details>");
    const off = await run(files, { repoFiles: { ".guardrails/config.json": JSON.stringify({ coverage: "off" }) } }).review();
    expect(off.body).not.toContain("Coverage:");
    expect(off.body).not.toContain("<details>");
    const def = await run(files).review();
    expect(def.body).toContain("<details><summary>What was reviewed</summary>");
  });
});

describe("reviewPullRequest: low-confidence deep findings (D-041)", () => {
  const f = (over: object) => ({ file: "src/a.ts", line: 2, type: "logic", severity: "medium", confidence: 0.7, title: "T", body: "B", evidence: [{ file: "src/a.ts", startLine: 1, endLine: 3, note: "n" }], ...over });
  const deepModel = (findings: object[]) => new MockLanguageModelV4({ doGenerate: async () => toolCall("report_findings", { findings, ruleChecks: [{ ruleId: "english-only", verdict: "violated" }, { ruleId: "no-todo", verdict: "ok" }] }) });

  it("moves model findings below 0.6 without a rule to the collapsed block (cap 5); rule findings stay inline", async () => {
    const many = Array.from({ length: 7 }, (_, i) => f({ line: 4 + i, title: `Weak observation ${"abcdefg"[i]} about ${["cats", "planets", "rivers", "engines", "poems", "bridges", "clocks"][i]}`, confidence: 0.4 + i * 0.01, evidence: [{ file: "src/a.ts", startLine: 4 + i, endLine: 4 + i, note: `n${i}` }] }));
    const strong = f({ line: 2, title: "Solid problem here", confidence: 0.9 });
    const ruleLow = f({ line: 3, title: "Low but cites a rule", confidence: 0.45, ruleId: "english-only", evidence: [{ file: "src/a.ts", startLine: 3, endLine: 3, note: "r" }] });
    const t = run([{ filename: "src/a.ts", status: "modified", patch: TEN }], {
      model: deepModel([strong, ruleLow, ...many]),
      labels: ["guardrails:deep"],
      repoFiles: { ".guardrails/rules.md": RULES_MD },
    });
    const { body, comments } = await t.review();
    const inlineTitles = comments.map((c) => c.body.split("\n")[0]);
    expect(inlineTitles.some((x) => x?.includes("Solid problem here"))).toBe(true);
    expect(inlineTitles.some((x) => x?.includes("Low but cites a rule"))).toBe(true);
    expect(inlineTitles.some((x) => x?.includes("Weak observation"))).toBe(false);
    expect(body).toContain("**Lower-confidence observations**");
    expect(body.match(/- `src\/a\.ts` Weak observation/g)!.length).toBeLessThanOrEqual(5);
    expect(body).toMatch(/- and \d+ more/);
    expect(body).toMatch(/2 findings: 0 from checks, 2 from the model/);
    expect(events("review.analyzed")[0]).toMatchObject({ lowConfidenceObservations: expect.any(Number) });
  });

  it("standard mode publishes as before (the threshold is a deep-only rule)", async () => {
    const t = run([{ filename: "src/a.ts", status: "modified", patch: SMALL }], { model: deepModel([f({ title: "Mid one", confidence: 0.65 })]) });
    const { body, comments } = await t.review();
    expect(comments).toHaveLength(1);
    expect(body).not.toContain("Lower-confidence");
  });

  it("with coverage line only, the observations still appear in their own collapsed block", async () => {
    const t = run([{ filename: "src/a.ts", status: "modified", patch: SMALL }], {
      model: deepModel([f({ title: "Weak one", confidence: 0.45 })]),
      labels: ["guardrails:deep"],
      repoFiles: { ".guardrails/config.json": JSON.stringify({ coverage: "line" }) },
    });
    const { body, comments } = await t.review();
    expect(comments).toHaveLength(0);
    expect(body).toContain("<details><summary>Lower-confidence observations</summary>");
    expect(body).not.toContain("What was reviewed");
  });
});
