import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Rule } from "../config";
import { parseUnifiedDiff } from "../diff";
import { MAX_ALSO_AT, MAX_BODY_CHARS } from "../findings/dedupe";
import { mergeModelIntoChecks } from "../findings/check-merge";
import { reviewDiff } from "../review";
import type { Finding } from "../types";
import { addDiff, memWorkspace } from "./checks.test";

type GenResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const report = (input: unknown): GenResult => ({
  content: [{ type: "tool-call", toolCallId: "r", toolName: "report_findings", input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
const modelWith = (findings: object[]) => new MockLanguageModelV4({ doGenerate: async () => report({ findings }) });

const BADGE = "src/components/Badge.tsx";
const OTHER = "src/components/Other.tsx";
const lines = (n: number, first: string) => [first, ...Array.from({ length: n - 1 }, (_, i) => `const v${i + 2} = ${i + 2};`)].join("\n") + "\n";
const files = {
  [BADGE]: lines(60, "import { repo } from '../data/repository';"),
  [OTHER]: lines(10, "const a = 1;"),
};
const input = { diff: addDiff(files), context: {}, docs: {} };
const ws = memWorkspace(files);
const layers: Rule = { id: "layers", rule: "Components do not touch data.", scope: ["src/components/**"], severity: "medium", status: "active", check: "forbid-import: **/data/**" };
const other: Rule = { id: "other", rule: "Other rule.", scope: ["src/**"], severity: "medium", status: "active" };
const short: Rule = { id: "short", rule: "Short files.", scope: [OTHER], severity: "high", status: "active", check: "max-lines: 3" };
const config = { ...defaultConfig, rules: [layers, other, short] };

const at = (file: string, line: number) => [{ file, startLine: line, endLine: line, note: "x" }];
const llm = (over: object = {}) => ({
  file: BADGE,
  line: 5,
  type: "logic",
  severity: "medium",
  confidence: 0.9,
  title: "Data access from the component",
  body: "The component calls the repository directly.",
  ruleId: "layers",
  evidence: at(BADGE, 5),
  ...over,
});
const run = (findings: object[]) => reviewDiff(input, { config, model: modelWith(findings), mode: "agent", workspace: ws });

describe("check and model findings of one rule and file become one comment (v0.8.1)", () => {
  it("(a) the PR #9 shape: import at line 1, use at line 5", async () => {
    const r = await run([llm()]);
    const layered = r.findings.filter((f) => f.ruleId === "layers");
    expect(layered).toHaveLength(1);
    expect(layered[0]).toMatchObject({ origin: "check", line: 1 });
    expect(layered[0]!.body).toContain("Also at line 5.");
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });

  it("(b) merges whatever the distance", async () => {
    const r = await run([llm({ line: 10, evidence: at(BADGE, 10) }), llm({ line: 40, evidence: at(BADGE, 40) })]);
    const layered = r.findings.filter((f) => f.ruleId === "layers");
    expect(layered).toHaveLength(1);
    expect(layered[0]!.body).toContain("Also at lines 10, 40.");
    expect(r.findings.every((f) => f.origin === "check")).toBe(true);
  });

  it("(c) a model finding of the same rule in another file stays its own comment", async () => {
    const r = await run([llm({ file: OTHER, line: 3, evidence: at(OTHER, 3) })]);
    expect(r.findings.some((x) => x.origin === "llm" && x.file === OTHER && x.ruleId === "layers")).toBe(true);
    expect(r.findings.find((x) => x.origin === "check" && x.ruleId === "layers")!.body).not.toContain("Also at");
  });

  it("(d) another rule or no rule is not merged", async () => {
    const r = await run([
      llm({ ruleId: "other", title: "Other thing" }),
      llm({ ruleId: undefined, severity: "low", line: 6, title: "Read on every render", evidence: at(BADGE, 6) }),
    ]);
    expect(r.findings.filter((f) => f.origin === "llm")).toHaveLength(2);
    expect(r.findings.find((x) => x.origin === "check" && x.ruleId === "layers")!.body).not.toContain("Also at");
  });

  it("(e) an exhaustive rule still drops the model finding without touching the check comment", async () => {
    const r = await run([llm({ file: OTHER, ruleId: "short", line: 2, evidence: at(OTHER, 2) })]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
    expect(r.findings.some((x) => x.origin === "llm")).toBe(false);
    expect(r.findings.find((x) => x.ruleId === "short")!.body).not.toContain("Also at");
  });

  it("(f) an extra line that is not an added line is not listed, yet the finding is still merged", async () => {
    const r = await run([llm({ line: 500, evidence: at(BADGE, 500) })]);
    const layered = r.findings.filter((f) => f.ruleId === "layers");
    expect(layered).toHaveLength(1);
    expect(layered[0]!.body).not.toContain("Also at");
    expect(r.findings.some((f) => f.origin === "llm")).toBe(false);
    expect(r.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
  });

  it("(g) the check finding keeps severity, confidence 1 and anchor", async () => {
    const before = await run([]);
    const after = await run([llm({ severity: "high", confidence: 0.95 })]);
    const pick = (r: typeof before) => r.findings.find((f) => f.origin === "check" && f.ruleId === "layers")!;
    expect(pick(after)).toMatchObject({ severity: pick(before).severity, confidence: 1, file: BADGE, line: 1, origin: "check", title: pick(before).title });
  });

  it("(i) coverage counts the merge as a duplicate", async () => {
    const r = await run([llm()]);
    expect(r.coverage.dropped).toEqual({ duplicate: 1 });
  });
});

describe("mergeModelIntoChecks", () => {
  const diff = parseUnifiedDiff(input.diff);
  const check = (over: Partial<Finding> = {}): Finding =>
    ({ file: BADGE, line: 1, type: "style", severity: "medium", confidence: 1, title: "Import", body: "Forbidden import.", ruleId: "layers", origin: "check", evidence: [], ...over }) as Finding;
  const model = (line: number, over: Partial<Finding> = {}): Finding => ({ ...check({ origin: "llm", confidence: 0.9 }), line, ...over }) as Finding;

  it("(h) lists at most 6 locations with 'and K more' and stays within the length limit", () => {
    const out = mergeModelIntoChecks([check({ body: "x".repeat(MAX_BODY_CHARS) })], [2, 3, 4, 5, 6, 7, 8, 9, 10].map((l) => model(l)), diff)[0]!;
    expect(MAX_ALSO_AT).toBe(6);
    expect(out.body).toContain("Also at lines 2, 3, 4, 5, 6, 7 and 3 more.");
    expect(out.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(out.body.endsWith("and 3 more.")).toBe(true);
  });

  it("merges into the closest check finding of the rule and file", () => {
    const [a, b] = mergeModelIntoChecks([check({ line: 1 }), check({ line: 30, body: "Second." })], [model(28)], diff);
    expect(a!.body).not.toContain("Also at");
    expect(b!.body).toContain("Also at line 28.");
  });

  it("compares normalised paths", () => {
    const out = mergeModelIntoChecks([check()], [model(5, { file: "./" + BADGE })], diff)[0]!;
    expect(out.body).toContain("Also at line 5.");
  });

  it("(j) is idempotent and does not mutate its inputs", () => {
    const c = check();
    const once = mergeModelIntoChecks([c], [model(5)], diff);
    const twice = mergeModelIntoChecks(once, [model(5)], diff);
    expect(twice).toEqual(once);
    expect(c.body).toBe("Forbidden import.");
    expect(mergeModelIntoChecks([c], [model(5)], diff)).toEqual(once);
  });
});
