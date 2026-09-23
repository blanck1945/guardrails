import { describe, expect, it } from "vitest";
import {
  isFixPr,
  isMeaningfulLine,
  isSourceFile,
  parseBlamePorcelain,
  parseRemovedRanges,
  pickIntroducingCommit,
  toRanges,
} from "./szz-lib";

describe("parseRemovedRanges", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,3 @@ fn",
    "@@ -20 +21 @@",
    "@@ -30,0 +32,2 @@",
    "diff --git a/new.ts b/new.ts",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,5 @@",
  ].join("\n");

  it("keeps old-side ranges of modified/deleted lines, skips pure additions and new files", () => {
    expect([...parseRemovedRanges(diff).entries()]).toEqual([["src/a.ts", [[10, 11], [20, 20]]]]);
  });
});

describe("parseBlamePorcelain", () => {
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  const out = [
    `${sha1} 5 10 1`,
    "author x",
    "committer-time 1700000000",
    "filename src/old.ts",
    "\tconst a = 1;",
    `${sha2} 7 11 1`,
    "committer-time 1600000000",
    "boundary",
    "filename src/x.ts",
    "\t\treturn a;",
  ].join("\n");

  it("extracts commit, original line, file, time and boundary", () => {
    expect(parseBlamePorcelain(out)).toEqual([
      { commit: sha1, origLine: 5, filename: "src/old.ts", committerTime: 1700000000, boundary: false, content: "const a = 1;" },
      { commit: sha2, origLine: 7, filename: "src/x.ts", committerTime: 1600000000, boundary: true, content: "\treturn a;" },
    ]);
  });
});

describe("helpers", () => {
  it("toRanges collapses consecutive lines", () => {
    expect(toRanges([5, 3, 4, 9, 10, 3])).toEqual([[3, 5], [9, 10]]);
  });
  it("isMeaningfulLine drops blanks and comments", () => {
    expect(isMeaningfulLine("   ")).toBe(false);
    expect(isMeaningfulLine("  // note")).toBe(false);
    expect(isMeaningfulLine("# note")).toBe(false);
    expect(isMeaningfulLine("x = 1")).toBe(true);
  });
  it("isFixPr matches titles and bug labels", () => {
    expect(isFixPr("fix(router): handle empty path", [])).toBe(true);
    expect(isFixPr("Fix crash on null", [])).toBe(true);
    expect(isFixPr("feat: add fixture", [])).toBe(false);
    expect(isFixPr("Prefix handling", [])).toBe(false);
    expect(isFixPr("Tweak thing", ["Bug"], "bug")).toBe(true);
  });
  it("isSourceFile excludes tests, docs and other languages", () => {
    expect(isSourceFile("src/router.ts", "ts")).toBe(true);
    expect(isSourceFile("src/router.test.ts", "ts")).toBe(false);
    expect(isSourceFile("tests/a.py", "py")).toBe(false);
    expect(isSourceFile("fastapi/routing.py", "py")).toBe(true);
    expect(isSourceFile("fastapi/routing.py", "ts")).toBe(false);
    expect(isSourceFile("types.d.ts", "ts")).toBe(false);
  });
  it("pickIntroducingCommit takes the commit with most lines, ties by recency", () => {
    const l = (commit: string, t: number) => ({ commit, committerTime: t });
    expect(pickIntroducingCommit([l("a", 1), l("b", 2), l("b", 2), l("a", 1)])?.commit).toBe("b");
    expect(pickIntroducingCommit([])).toBeNull();
  });
});
