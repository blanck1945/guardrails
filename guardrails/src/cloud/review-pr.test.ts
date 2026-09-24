import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError } from "@/core/cost";
import { RepoTooLargeError, TarballDownloadError, type Workspace } from "@/core/workspace";
import {
  classifyFailure,
  FAILURE_MESSAGES,
  reviewPullRequest,
  reviewSettings,
  type DisposableWorkspace,
  type ReviewPrDeps,
} from "./review-pr";
import type { PullRequestEvent } from "./webhook";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const finding = {
  file: "src/a.ts",
  line: 2,
  type: "logic",
  severity: "high",
  confidence: 0.9,
  title: "Off by one",
  body: "Loop bound is wrong.",
  evidence: [{ file: "src/a.ts", startLine: 1, endLine: 3, note: "loop" }],
};

const toolCall = (toolName: string, input: unknown, id: string, u = usage(100, 10)): GenResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: u,
  warnings: [],
});

const textResult = (text: string, u = usage(100, 10)): GenResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: undefined },
  usage: u,
  warnings: [],
});

const agentModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => toolCall("report_findings", { findings: [finding], notes: "agent summary" }, "r1"),
  });

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

const PATCH = "@@ -1,2 +1,3 @@\n export function f() {\n+  for (let i = 0; i <= n; i++) {}\n }";

function fakeOcto() {
  const createReview = vi.fn(async (_: unknown) => ({}));
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path === "src/a.ts") return { data: { type: "file", content: Buffer.from("export function f() {}\n").toString("base64") } };
    throw Object.assign(new Error("not found"), { status: 404 });
  });
  const listFiles = vi.fn();
  const octo = {
    rest: {
      pulls: {
        get: async () => ({ data: { title: "Add loop", body: "desc", base: { sha: "basesha" }, head: { sha: "headsha" } } }),
        listFiles,
        createReview,
      },
      repos: { getContent },
    },
    paginate: async () => [{ filename: "src/a.ts", status: "modified", patch: PATCH }],
  };
  return { octo, createReview, getContent };
}

function fakeWorkspace() {
  const dispose = vi.fn(async () => {});
  const ws: DisposableWorkspace = {
    readFile: async (i) => ({ path: i.path, ref: i.ref ?? "head", startLine: 1, endLine: 1, totalLines: 1, content: "1\tx", truncated: false }),
    grep: async () => ({ matches: [], truncated: false }),
    listFiles: async () => ({ files: ["src/a.ts"], truncated: false }),
    diff: async () => "",
    findReferencesByName: async () => ({ references: [], truncated: false }),
    dispose,
  } satisfies Workspace & { dispose(): Promise<void> };
  return { ws, dispose };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

const events = (name: string) => logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === name);

function setup(overrides: Partial<ReviewPrDeps> = {}, ws = fakeWorkspace()) {
  const o = fakeOcto();
  const createWorkspace = vi.fn(async () => ws.ws);
  const deps: ReviewPrDeps = {
    octokit: async () => o.octo as never,
    createWorkspace,
    env: {},
    model: agentModel(),
    ...overrides,
  };
  return { ...o, ...ws, createWorkspace, deps };
}

describe("reviewSettings", () => {
  it("defaults to agent, the mode's own budget (no override) and 240 s", () => {
    expect(reviewSettings({})).toEqual({ mode: "agent", budgetUsd: undefined, timeoutSec: 240 });
  });
  it("reads the env and ignores invalid values", () => {
    expect(reviewSettings({ GUARDRAILS_MODE: "single", GUARDRAILS_REVIEW_BUDGET_USD: "1.5", GUARDRAILS_REVIEW_TIMEOUT_SEC: "100" })).toEqual({
      mode: "single",
      budgetUsd: 1.5,
      timeoutSec: 100,
    });
    expect(reviewSettings({ GUARDRAILS_MODE: "bogus", GUARDRAILS_REVIEW_BUDGET_USD: "-1", GUARDRAILS_REVIEW_TIMEOUT_SEC: "abc" })).toEqual({
      mode: "agent",
      budgetUsd: undefined,
      timeoutSec: 240,
    });
  });
});

describe("reviewPullRequest: agent mode", () => {
  it("runs the agent over the tarball workspace, publishes inline and disposes", async () => {
    const t = setup();
    await reviewPullRequest(ev, t.deps);
    expect(t.createWorkspace).toHaveBeenCalledOnce();
    const opts = (t.createWorkspace.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(opts).toMatchObject({ owner: "o", repo: "r", baseRef: "basesha", headRef: "headsha" });
    expect(String(opts.diff)).toContain("+++ b/src/a.ts");
    expect(t.dispose).toHaveBeenCalledOnce();
    expect(events("review.fallback")).toEqual([]);
    expect(events("review.analyzed")[0]).toMatchObject({ mode: "agent", findings: 1 });

    const review = t.createReview.mock.calls[0][0] as { commit_id: string; body: string; comments: { path: string; line: number; body: string }[] };
    expect(review.commit_id).toBe("headsha");
    expect(review.body).toContain("agent summary");
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: "src/a.ts", line: 2 });
    // agent mode does not pre-read file contents through the contents API for the prompt (only docs and config)
    expect(t.getContent.mock.calls.map((c) => (c[0] as { path: string }).path)).not.toContain("src/a.ts");
  });

  it("uses refs/pull/N/head for a PR from a fork", async () => {
    const t = setup();
    await reviewPullRequest({ ...ev, isFork: true }, t.deps);
    const opts = (t.createWorkspace.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(opts.headRef).toBe("refs/pull/7/head");
  });

  it("does not log code, diffs or tokens", async () => {
    const t = setup();
    await reviewPullRequest(ev, t.deps);
    const all = logs.join("\n");
    expect(all).not.toContain("export function");
    expect(all).not.toContain("Off by one");
  });
});

describe("reviewPullRequest: fallback to single", () => {
  const singleModel = () =>
    new MockLanguageModelV4({
      doGenerate: async () => textResult(JSON.stringify({ summary: "single summary", findings: [] })),
    });

  it.each([
    ["repo-too-large", new RepoTooLargeError("bytes", 1)],
    ["download-timeout", new TarballDownloadError("timeout")],
    ["download-failed", new TarballDownloadError("failed")],
  ])("falls back on %s, logging the reason", async (reason, err) => {
    const t = setup({ model: singleModel() });
    t.createWorkspace.mockRejectedValueOnce(err);
    await reviewPullRequest(ev, t.deps);
    expect(events("review.fallback")).toEqual([
      expect.objectContaining({ reason, from: "agent", to: "single", repo: "o/r", pr: 7 }),
    ]);
    expect(events("review.analyzed")[0]).toMatchObject({ mode: "single" });
    expect(t.dispose).not.toHaveBeenCalled(); // nothing was created
    expect((t.createReview.mock.calls[0][0] as { body: string }).body).toContain("single summary");
    // single mode reads changed files through the contents API
    expect(t.getContent.mock.calls.map((c) => (c[0] as { path: string }).path)).toContain("src/a.ts");
  });

  it("GUARDRAILS_MODE=single skips the tarball entirely", async () => {
    const t = setup({ model: singleModel(), env: { GUARDRAILS_MODE: "single" } });
    await reviewPullRequest(ev, t.deps);
    expect(t.createWorkspace).not.toHaveBeenCalled();
    expect(events("review.fallback")).toEqual([]);
    expect(events("review.analyzed")[0]).toMatchObject({ mode: "single" });
  });
});

describe("reviewPullRequest: dispose, budget, timeout", () => {
  it("disposes when the model fails", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("model exploded");
      },
    });
    const t = setup({ model });
    await expect(reviewPullRequest(ev, t.deps)).rejects.toThrow();
    expect(t.dispose).toHaveBeenCalledOnce();
    expect(t.createReview).not.toHaveBeenCalled();
  });

  it("disposes on the review-wide timeout and classifies it", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: (o) =>
        new Promise<GenResult>((_, reject) => {
          o.abortSignal?.addEventListener("abort", () => reject(o.abortSignal?.reason ?? new Error("aborted")));
        }),
    });
    const t = setup({ model, env: { GUARDRAILS_REVIEW_TIMEOUT_SEC: "0.05" } });
    const err = await reviewPullRequest(ev, t.deps).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(classifyFailure(err)).toBe("timeout");
    expect(FAILURE_MESSAGES.timeout).toMatch(/ran out of time/);
    expect(t.dispose).toHaveBeenCalledOnce();
    expect(t.createReview).not.toHaveBeenCalled();
  });

  it("a budget failure has no fallback: it surfaces as the generic budget notice", async () => {
    // Unpriced mock model: the cap is derived from USD as tokens (~1000 tokens for 0.001 USD).
    const model = new MockLanguageModelV4({
      doGenerate: async () => toolCall("read_file", { path: "src/a.ts" }, "c1", usage(900, 200)),
    });
    const t = setup({ model, env: { GUARDRAILS_REVIEW_BUDGET_USD: "0.001" } });
    const err = await reviewPullRequest(ev, t.deps).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(classifyFailure(err)).toBe("budget");
    expect(FAILURE_MESSAGES.budget).toMatch(/spend limit/);
    expect(t.createWorkspace).toHaveBeenCalledOnce();
    expect(events("review.fallback")).toEqual([]);
    expect(t.dispose).toHaveBeenCalledOnce();
    expect(t.createReview).not.toHaveBeenCalled();
  });

  it("an aborted download (review-wide timeout) does not fall back", async () => {
    const t = setup({ env: { GUARDRAILS_REVIEW_TIMEOUT_SEC: "0.01" } });
    t.createWorkspace.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 40));
      throw new TarballDownloadError("failed");
    });
    await expect(reviewPullRequest(ev, t.deps)).rejects.toBeInstanceOf(TarballDownloadError);
    expect(events("review.fallback")).toEqual([]);
  });
});
