import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCases, loadRepos } from "./loader";
import { caseSchema } from "./schema";

const sha = "a".repeat(40);
const valid = {
  id: "x-1",
  repo: "https://github.com/o/r",
  baseSha: sha,
  headSha: "b".repeat(40),
  source: "szz",
  language: "ts",
  validated: false,
  bugs: [{ file: "a.ts", lines: [1, 2], description: "d", severity: "high", category: "logic", crossFile: false }],
};

describe("caseSchema", () => {
  it("accepts a valid case and defaults relatedFiles", () => {
    const r = caseSchema.parse(valid);
    expect(r.bugs[0].relatedFiles).toEqual([]);
  });

  it("rejects short SHAs, inverted line ranges and clean cases with bugs", () => {
    expect(caseSchema.safeParse({ ...valid, baseSha: "abc" }).success).toBe(false);
    const inv = { ...valid, bugs: [{ ...valid.bugs[0], lines: [5, 2] }] };
    expect(caseSchema.safeParse(inv).success).toBe(false);
    expect(caseSchema.safeParse({ ...valid, source: "clean" }).success).toBe(false);
    expect(caseSchema.safeParse({ ...valid, bugs: [] }).success).toBe(false);
  });
});

describe("loader", () => {
  it("loads the seed cases and repos.json", async () => {
    const { cases, issues } = await loadCases();
    expect(issues).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect((await loadRepos()).issues).toEqual([]);
  });

  it("reports invalid JSON, schema errors and id/dir mismatch without throwing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-cases-"));
    try {
      for (const [d, body] of [
        ["bad-json", "{"],
        ["bad-schema", JSON.stringify({ ...valid, id: "bad-schema", baseSha: "zz" })],
        ["mismatch", JSON.stringify({ ...valid, id: "other" })],
        ["ok", JSON.stringify({ ...valid, id: "ok" })],
      ] as const) {
        mkdirSync(path.join(dir, d));
        writeFileSync(path.join(dir, d, "case.json"), body);
      }
      const { cases, issues } = await loadCases(dir);
      expect(cases.map((c) => c.id)).toEqual(["ok"]);
      expect(issues).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
