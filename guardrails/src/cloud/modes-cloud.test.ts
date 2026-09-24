import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/core/workspace";
import { REQUIRED_PERMISSIONS, SUBSCRIBED_EVENTS } from "./app-permissions";
import { reviewPullRequest, type DisposableWorkspace, type ReviewPrDeps } from "./review-pr";
import { verifySignature } from "./github";
import { DeliveryDedupe, handleWebhook, parsePullRequestEvent, type PullRequestEvent, type WebhookDeps } from "./webhook";

const SECRET = "test-secret";
const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/pull_request.opened.json"), "utf8"));

beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function request(payload: unknown, delivery: string) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    body,
    headers: { "x-github-event": "pull_request", "x-github-delivery": delivery, "x-hub-signature-256": sig },
  });
}

function hook() {
  const pending: Promise<unknown>[] = [];
  const review = vi.fn(async (_ev: PullRequestEvent) => {});
  const deps: WebhookDeps = {
    verifySignature,
    schedule: (fn) => void pending.push(fn()),
    loadTriggers: async () => ({ drafts: false, forks: true, skipLabels: ["skip-guardrails"] }),
    review,
    reportFailure: async () => {},
    dedupe: new DeliveryDedupe(),
    ownAppId: "999",
  };
  return { deps, review, settle: () => Promise.all(pending) };
}

const labelEvent = (action: string, name: string) => ({ ...fixture, action, label: { name } });

describe("webhook: labeled / unlabeled", () => {
  it("re-reviews when a guardrails:* label is added or removed (any case)", async () => {
    const h = hook();
    let i = 0;
    for (const [action, name] of [["labeled", "guardrails:deep"], ["unlabeled", "guardrails:deep"], ["labeled", "Guardrails:Basic"]] as const) {
      const res = await handleWebhook(request(labelEvent(action, name), `d-${i++}`), h.deps);
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("accepted");
    }
    await h.settle();
    expect(h.review).toHaveBeenCalledTimes(3);
  });

  it("ignores every other label and other actions", async () => {
    const h = hook();
    let i = 0;
    for (const p of [labelEvent("labeled", "bug"), labelEvent("unlabeled", "skip-guardrails"), labelEvent("labeled", "guardrail"), { ...fixture, action: "labeled" }, { ...fixture, action: "edited" }, { ...fixture, action: "closed" }]) {
      const res = await handleWebhook(request(p, `x-${i++}`), h.deps);
      expect(res.status).toBe(202);
      expect(await res.text()).toMatch(/^ignored/);
    }
    await h.settle();
    expect(h.review).not.toHaveBeenCalled();
  });

  it("the payload label is parsed and no new event or permission was added", () => {
    expect(parsePullRequestEvent(labelEvent("labeled", "guardrails:deep"))?.label).toBe("guardrails:deep");
    expect(parsePullRequestEvent(fixture)?.label).toBeUndefined();
    expect(SUBSCRIBED_EVENTS).toEqual(["pull_request"]);
    expect(REQUIRED_PERMISSIONS).toEqual({ metadata: "read", contents: "read", pull_requests: "write" });
  });
});

// ---------------------------------------------------------------------------------------------

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const finding = { file: "src/a.ts", line: 2, type: "logic", severity: "high", confidence: 0.5, title: "Weak signal", body: "Maybe.", evidence: [{ file: "src/a.ts", startLine: 1, endLine: 3, note: "x" }] };
const PATCH = "@@ -1,2 +1,3 @@\n export function f() {\n+  for (let i = 0; i <= n; i++) {}\n }";
const ev: PullRequestEvent = { installationId: 1, owner: "o", repo: "r", number: 7, headSha: "headsha", baseSha: "basesha", action: "labeled", draft: false, isFork: false, labels: [], senderLogin: "dev", senderType: "User" };

function scenario(over: { labels?: string[]; body?: string; config?: object } = {}) {
  const createReview = vi.fn(async (_: unknown) => ({}));
  const getContent = vi.fn(async ({ path: p }: { path: string }) => {
    if (p === ".guardrails/config.json" && over.config) return { data: { type: "file", content: Buffer.from(JSON.stringify(over.config)).toString("base64") } };
    throw Object.assign(new Error("not found"), { status: 404 });
  });
  const octo = {
    rest: {
      pulls: {
        get: async () => ({ data: { title: "t", body: over.body ?? "", labels: (over.labels ?? []).map((name) => ({ name })), base: { sha: "basesha" }, head: { sha: "headsha" } } }),
        listFiles: vi.fn(),
        createReview,
      },
      repos: { getContent },
    },
    paginate: async () => [{ filename: "src/a.ts", status: "modified", patch: PATCH, additions: 1, deletions: 0 }],
  };
  const ws: DisposableWorkspace = {
    readFile: async (i) => ({ path: i.path, ref: i.ref ?? "head", startLine: 1, endLine: 1, totalLines: 1, content: "1\tx", truncated: false }),
    grep: async () => ({ matches: [], truncated: false }),
    listFiles: async () => ({ files: ["src/a.ts"], truncated: false }),
    diff: async () => "",
    findReferencesByName: async () => ({ references: [], truncated: false }),
    dispose: async () => {},
  } satisfies Workspace & { dispose(): Promise<void> };
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: "tool-call" as const, toolCallId: "r", toolName: "report_findings", input: JSON.stringify({ findings: [finding], ruleChecks: [] }) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] }),
  });
  const deps: ReviewPrDeps = { octokit: async () => octo as never, createWorkspace: async () => ws, env: {}, model };
  const posted = () => createReview.mock.calls[0]![0] as { body: string; comments: unknown[] };
  return { deps, posted, model };
}

describe("reviewPullRequest: review mode", () => {
  it("default: standard; the 0.5-confidence finding is dropped and the summary says why", async () => {
    const s = scenario();
    await reviewPullRequest(ev, s.deps);
    expect(s.posted().comments).toHaveLength(0);
    expect(s.posted().body).toContain("Review mode: standard (default).");
  });

  it("label guardrails:deep applies the deep preset (confidence 0.4, 2 passes)", async () => {
    const s = scenario({ labels: ["bug", "Guardrails:Deep"] });
    await reviewPullRequest(ev, s.deps);
    expect(s.posted().comments).toHaveLength(1);
    expect(s.posted().body).toContain("Review mode: deep (label guardrails:deep).");
    expect(s.model.doGenerateCalls).toHaveLength(2);
  });

  it("description line selects the mode", async () => {
    const s = scenario({ body: "Refactor\n\nguardrails-mode: deep" });
    await reviewPullRequest(ev, s.deps);
    expect(s.posted().body).toContain("description line guardrails-mode: deep");
  });

  it("prOverride none ignores label and description (config comes from the base)", async () => {
    const s = scenario({ labels: ["guardrails:basic"], body: "guardrails-mode: basic", config: { prOverride: "none", mode: "deep" } });
    await reviewPullRequest(ev, s.deps);
    expect(s.posted().body).toContain("Review mode: deep (config.json default).");
  });

  it("autoMode from the base config", async () => {
    const s = scenario({ config: { autoMode: [{ filesLessThan: 3, mode: "basic" }] } });
    await reviewPullRequest(ev, s.deps);
    expect(s.posted().body).toContain("Review mode: basic (autoMode rule #1");
  });
});
