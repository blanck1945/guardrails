import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifySignature } from "./github";
import { sanitizeLogFields } from "./log";
import { classifyFailure, DiffTooLargeError, FAILURE_MESSAGES } from "./review-pr";
import { DeliveryDedupe, evaluateTriggers, handleWebhook, parsePullRequestEvent, type Triggers, type WebhookDeps } from "./webhook";

const SECRET = "test-secret";
const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/pull_request.opened.json"), "utf8"));
const DEFAULT_TRIGGERS: Triggers = { drafts: false, forks: true, skipLabels: ["skip-guardrails"] };

beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function request(payload: unknown, opts: { event?: string; delivery?: string; signature?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const sig = opts.signature === undefined ? "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex") : opts.signature;
  const headers: Record<string, string> = { "x-github-event": opts.event ?? "pull_request", "x-github-delivery": opts.delivery ?? "d-1" };
  if (sig) headers["x-hub-signature-256"] = sig;
  return new Request("https://example.test/api/webhooks/github", { method: "POST", body, headers });
}

function setup(triggers: Triggers = DEFAULT_TRIGGERS) {
  const pending: Promise<unknown>[] = [];
  const review = vi.fn(async (_ev: unknown) => {});
  const reportFailure = vi.fn(async (_ev: unknown, _err: unknown) => {});
  const deps: WebhookDeps = {
    verifySignature,
    schedule: (fn) => void pending.push(fn()),
    loadTriggers: async () => triggers,
    review,
    reportFailure,
    dedupe: new DeliveryDedupe(),
    ownAppId: "999",
  };
  return { deps, review, reportFailure, settle: () => Promise.all(pending) };
}

describe("handleWebhook", () => {
  it("rejects an invalid or missing signature with 401 and reviews nothing", async () => {
    const s = setup();
    expect((await handleWebhook(request(fixture, { signature: "sha256=deadbeef" }), s.deps)).status).toBe(401);
    expect((await handleWebhook(request(fixture, { signature: null }), s.deps)).status).toBe(401);
    await s.settle();
    expect(s.review).not.toHaveBeenCalled();
  });

  it("answers 202 and reviews a normal opened PR", async () => {
    const s = setup();
    const res = await handleWebhook(request(fixture), s.deps);
    expect(res.status).toBe(202);
    await s.settle();
    expect(s.review).toHaveBeenCalledTimes(1);
    expect(s.review.mock.calls[0]![0]).toMatchObject({ owner: "acme", repo: "widgets", number: 7, baseSha: "2".repeat(40), headSha: "1".repeat(40) });
  });

  it("the same delivery three times starts one review", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) expect((await handleWebhook(request(fixture, { delivery: "same" }), s.deps)).status).toBe(202);
    await s.settle();
    expect(s.review).toHaveBeenCalledTimes(1);
  });

  it("ignores unsupported events with 202", async () => {
    const s = setup();
    const res = await handleWebhook(request({ zen: "hi" }, { event: "ping" }), s.deps);
    expect(res.status).toBe(202);
    expect(await res.text()).toContain("ignored");
    expect((await handleWebhook(request(fixture, { event: "issue_comment", delivery: "d-2" }), s.deps)).status).toBe(202);
    await s.settle();
    expect(s.review).not.toHaveBeenCalled();
  });

  it("ignores actions that do not need a review", async () => {
    const s = setup();
    const p = clone(fixture);
    p.action = "closed";
    expect((await handleWebhook(request(p), s.deps)).status).toBe(202);
    await s.settle();
    expect(s.review).not.toHaveBeenCalled();
  });

  it("ignores drafts, unless the base config enables them", async () => {
    const draft = clone(fixture);
    draft.pull_request.draft = true;
    const s = setup();
    expect((await handleWebhook(request(draft), s.deps)).status).toBe(202);
    await s.settle();
    expect(s.review).not.toHaveBeenCalled();

    const s2 = setup({ ...DEFAULT_TRIGGERS, drafts: true });
    await handleWebhook(request(draft), s2.deps);
    await s2.settle();
    expect(s2.review).toHaveBeenCalledTimes(1);
  });

  it("ignores PRs with a skip label from the base config", async () => {
    const p = clone(fixture);
    p.pull_request.labels = [{ name: "skip-guardrails" }];
    const s = setup();
    await handleWebhook(request(p), s.deps);
    await s.settle();
    expect(s.review).not.toHaveBeenCalled();

    const custom = setup({ ...DEFAULT_TRIGGERS, skipLabels: ["no-bot"] });
    await handleWebhook(request(p), custom.deps);
    await custom.settle();
    expect(custom.review).toHaveBeenCalledTimes(1);
  });

  it("ignores forks only when triggers.forks is false", async () => {
    const p = clone(fixture);
    p.pull_request.head.repo = { full_name: "stranger/widgets", fork: true };
    const allow = setup();
    await handleWebhook(request(p), allow.deps);
    await allow.settle();
    expect(allow.review).toHaveBeenCalledTimes(1);

    const deny = setup({ ...DEFAULT_TRIGGERS, forks: false });
    await handleWebhook(request(p, { delivery: "d-fork" }), deny.deps);
    await deny.settle();
    expect(deny.review).not.toHaveBeenCalled();
  });

  it("ignores events from bots and from this App itself", async () => {
    const bot = clone(fixture);
    bot.sender = { login: "dependabot[bot]", type: "Bot" };
    const own = clone(fixture);
    own.performed_via_github_app = { id: 999 };
    const s = setup();
    await handleWebhook(request(bot, { delivery: "d-bot" }), s.deps);
    await handleWebhook(request(own, { delivery: "d-own" }), s.deps);
    await s.settle();
    expect(s.review).not.toHaveBeenCalled();
  });

  it("when the review fails it reports briefly and does not throw", async () => {
    const s = setup();
    s.review.mockRejectedValueOnce(new DiffTooLargeError(300_000, 200_000));
    expect((await handleWebhook(request(fixture), s.deps)).status).toBe(202);
    await s.settle();
    expect(s.reportFailure).toHaveBeenCalledTimes(1);
  });

  it("logs without code, diffs, bodies or secrets", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void logs.push(l));
    const p = clone(fixture);
    p.pull_request.body = "SECRET-BODY-TEXT";
    p.pull_request.title = "SECRET-TITLE";
    const s = setup();
    await handleWebhook(request(p), s.deps);
    await s.settle();
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join("\n");
    expect(all).not.toContain("SECRET-BODY-TEXT");
    expect(all).not.toContain("SECRET-TITLE");
    expect(all).not.toContain(SECRET);
    for (const l of logs) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe("DeliveryDedupe", () => {
  it("forgets a delivery after the TTL and bounds memory", () => {
    let t = 0;
    const d = new DeliveryDedupe(1000, 2, () => t);
    expect(d.firstSeen("a")).toBe(true);
    expect(d.firstSeen("a")).toBe(false);
    t = 1001;
    expect(d.firstSeen("a")).toBe(true);
    d.firstSeen("b");
    d.firstSeen("c"); // exceeds max 2: the oldest ("a") is evicted
    expect(d.firstSeen("a")).toBe(true);
  });
});

describe("helpers", () => {
  it("parsePullRequestEvent rejects unusable payloads", () => {
    expect(parsePullRequestEvent({})).toBeNull();
    expect(parsePullRequestEvent(null)).toBeNull();
    expect(parsePullRequestEvent(fixture)).toMatchObject({ isFork: false, draft: false, labels: [] });
  });

  it("evaluateTriggers is pure and covers each reason", () => {
    expect(evaluateTriggers({ draft: true, isFork: false, labels: [] }, DEFAULT_TRIGGERS)).toEqual({ review: false, reason: "draft" });
    expect(evaluateTriggers({ draft: false, isFork: true, labels: [] }, { ...DEFAULT_TRIGGERS, forks: false })).toEqual({ review: false, reason: "fork" });
    expect(evaluateTriggers({ draft: false, isFork: false, labels: ["skip-guardrails"] }, DEFAULT_TRIGGERS)).toEqual({ review: false, reason: "skip-label" });
    expect(evaluateTriggers({ draft: false, isFork: false, labels: [] }, DEFAULT_TRIGGERS)).toEqual({ review: true });
  });

  it("classifies failures and never puts internal details in the public message", () => {
    expect(classifyFailure(new DiffTooLargeError(1, 1))).toBe("diff-too-large");
    expect(classifyFailure({ status: 429 })).toBe("rate-limit");
    expect(classifyFailure({ status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } })).toBe("rate-limit");
    expect(classifyFailure(new Error("boom sk-123"))).toBe("other");
    for (const m of Object.values(FAILURE_MESSAGES)) expect(m).not.toMatch(/sk-|api key|token|stack|Error/i);
  });

  it("sanitizeLogFields drops denied fields and non-scalar values", () => {
    const out = sanitizeLogFields({ pr: 1, diff: "x", body: "y", prompt: "z", token: "t", nested: { a: 1 }, long: "a".repeat(500) });
    expect(Object.keys(out).sort()).toEqual(["long", "pr"]);
    expect((out.long as string).length).toBeLessThan(300);
  });
});
