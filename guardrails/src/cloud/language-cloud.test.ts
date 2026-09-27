import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/core/workspace";
import { FAILURE_MESSAGES, reviewPullRequest, type DisposableWorkspace, type ReviewPrDeps } from "./review-pr";
import { rulesChangeNote } from "./review-rules";
import type { PullRequestEvent } from "./webhook";

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const emptyReport = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "tool-call", toolCallId: "r1", toolName: "report_findings", input: JSON.stringify({ findings: [], ruleChecks: [{ ruleId: "english-only", verdict: "ok" }] }) }],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage,
      warnings: [],
    }),
  });
const ev: PullRequestEvent = { installationId: 1, owner: "o", repo: "r", number: 7, headSha: "headsha", baseSha: "basesha", action: "opened", draft: false, isFork: false, labels: [], senderLogin: "dev", senderType: "User" };
const PATCH = "@@ -0,0 +1,3 @@\n+export function f(a: number) {\n+  return a + 1;\n+}";
const RULES_MD = "## tests\nscope: src/**\nseverity: medium\ncheck: colocated-test\ncheck-coverage: exhaustive\nstatus: active\n\nEvery module has a test.\n\n## english-only\nscope: src/**\nstatus: active\n\nEnglish only.\n";

function fakeWs(): DisposableWorkspace {
  const texts: Record<string, string> = { "src/Badge.tsx": "export function f(a: number) {\n  return a + 1;\n}\n" };
  return {
    readFile: async (i) => ({ path: i.path, ref: i.ref ?? "head", startLine: 1, endLine: 3, totalLines: 3, content: (texts[i.path] ?? "x").split("\n").map((l, n) => `${n + 1}\t${l}`).join("\n"), truncated: false }),
    grep: async () => ({ matches: [], truncated: false }),
    listFiles: async () => ({ files: ["src/Badge.tsx"], truncated: false }),
    diff: async () => "",
    findReferencesByName: async () => ({ references: [], truncated: false }),
    dispose: async () => {},
  } satisfies Workspace & { dispose(): Promise<void> };
}

function review(repoFiles: Record<string, string>, model: MockLanguageModelV4 = emptyReport()) {
  const createReview = vi.fn(async (_: unknown) => ({}));
  const octo = {
    rest: {
      pulls: { get: async () => ({ data: { title: "t", body: "d", base: { sha: "basesha" }, head: { sha: "headsha" }, labels: [] } }), listFiles: vi.fn(), createReview },
      repos: {
        getContent: async ({ path }: { path: string }) => {
          const c = repoFiles[path];
          if (c !== undefined) return { data: { type: "file", content: Buffer.from(c).toString("base64") } };
          throw Object.assign(new Error("not found"), { status: 404 });
        },
      },
    },
    paginate: async () => [{ filename: "src/Badge.tsx", status: "added", patch: PATCH }],
  };
  const deps: ReviewPrDeps = { octokit: async () => octo as never, createWorkspace: async () => fakeWs(), env: {}, model };
  return reviewPullRequest(ev, deps).then(() => createReview.mock.calls[0]![0] as { body: string; comments: { body: string }[] });
}

beforeEach(() => void vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("cloud: language from the base config", () => {
  it("defaults to English: check comment, citation, summary and coverage", async () => {
    const r = await review({ ".guardrails/rules.md": RULES_MD });
    expect(r.comments[0]!.body).toContain("Missing test file: Badge.tsx has no test next to it");
    expect(r.comments[0]!.body).toContain("Add src/Badge.test.tsx.");
    expect(r.comments[0]!.body).toMatch(/\nRule `tests`$/);
    expect(r.body).toContain("Coverage:");
    expect(r.body).toContain("1 finding: 1 from checks, 0 from the model");
  });

  it("language: es in config.json at the base commit translates check comment, citation, summary and coverage", async () => {
    const r = await review({ ".guardrails/rules.md": RULES_MD, ".guardrails/config.json": '{"language":"es"}' });
    expect(r.comments[0]!.body).toContain("Falta el archivo de test: Badge.tsx no tiene un test al lado");
    expect(r.comments[0]!.body).toContain("Agrega src/Badge.test.tsx.");
    expect(r.comments[0]!.body).toMatch(/\nRegla `tests`$/);
    expect(r.body).toContain("modo standard");
    expect(r.body).toContain("1 hallazgo: 1 de checks, 0 del modelo");
    expect(r.body).toContain("Cobertura:");
    expect(r.body).toContain("<summary>Qué se revisó</summary>");
    expect(r.body).toContain("| `tests` | check |");
    expect(r.body).toContain("| `src/Badge.tsx` | reviewed |".replace("reviewed", "revisado"));
  });

  it("an invalid language falls back to English", async () => {
    const r = await review({ ".guardrails/rules.md": RULES_MD, ".guardrails/config.json": '{"language":"xx"}' });
    expect(r.body).toContain("Coverage:");
  });

  it("notices: rules-change note and failure messages exist in Spanish; English is unchanged", () => {
    expect(rulesChangeNote([".guardrails/rules.md"])).toContain("This PR changes the Guardrails rules (`.guardrails/rules.md`)");
    expect(rulesChangeNote([".guardrails/rules.md"], "es")).toContain("Este PR cambia las reglas de Guardrails (`.guardrails/rules.md`)");
    expect(rulesChangeNote(["a.ts"], "es")).toBeNull();
    expect(FAILURE_MESSAGES.timeout).toBe("**Guardrails** stopped this review because it ran out of time. Push a new commit to try again.");
  });
});
