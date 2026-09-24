import { describe, expect, it } from "vitest";
import type { Rule } from "../config";
import { parseUnifiedDiff } from "../diff";
import { formatReadResult } from "../workspace/format";
import type { Workspace } from "../workspace";
import { hasLogic, importMatches, importSpecifiers, maskLines, parseCheck, runChecks } from "./index";

/** In-memory head tree. */
export function memWorkspace(files: Record<string, string>): Workspace {
  return {
    readFile: async (i) => {
      const text = files[i.path];
      if (text === undefined) throw new Error(`not found: ${i.path}`);
      return formatReadResult(text, i.path, i.ref ?? "head", i);
    },
    grep: async () => ({ matches: [], truncated: false }),
    listFiles: async () => ({ files: Object.keys(files).sort(), truncated: false }),
    diff: async () => "",
    findReferencesByName: async () => ({ references: [], truncated: false }),
  };
}

/** Diff that adds every line of `files[path]` as a new file. */
export function addDiff(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([p, c]) => {
      const lines = c.replace(/\n$/, "").split("\n");
      return `--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
    })
    .join("\n");
}

const rule = (over: Partial<Rule> & { id: string }): Rule => ({ rule: `Rule ${over.id} text.`, scope: ["**"], severity: "medium", status: "active", ...over });
const run = (rules: Rule[], files: Record<string, string>, diffFiles = files, ws = true) =>
  runChecks({ rules, files: parseUnifiedDiff(addDiff(diffFiles)), workspace: ws ? memWorkspace(files) : undefined });

describe("parseCheck", () => {
  it("accepts each type", () => {
    expect(parseCheck("max-lines: 150")).toEqual({ ok: true, spec: { kind: "max-lines", max: 150 } });
    expect(parseCheck("colocated-test")).toEqual({ ok: true, spec: { kind: "colocated-test" } });
    expect(parseCheck("forbid-import: **/repositories/**")).toEqual({ ok: true, spec: { kind: "forbid-import", pattern: "**/repositories/**" } });
    expect(parseCheck("forbid-pattern: [áé]")).toEqual({ ok: true, spec: { kind: "forbid-pattern", source: "[áé]", flags: "" } });
    expect(parseCheck("forbid-pattern(comments): /TODO/i")).toEqual({ ok: true, spec: { kind: "forbid-pattern", source: "TODO", flags: "i", only: "comments" } });
  });
  it("rejects invalid syntax", () => {
    const bad = ["max-lines", "max-lines: abc", "max-lines: 0", "colocated-test: x", "forbid-import:", "forbid-pattern: (", "forbid-pattern: (a+)+$", "forbid-pattern: /x/g", "forbid-pattern(bogus): x", "max-lines(comments): 3", "nope: 1", "forbid-pattern: " + "a".repeat(201)];
    for (const b of bad) expect(parseCheck(b).ok, b).toBe(false);
  });
});

describe("max-lines", () => {
  const r = rule({ id: "short", check: "max-lines: 3", scope: ["src/**"], exclude: ["src/gen/**"] });
  it("flags files over the limit, on an added line", async () => {
    const out = await run([r], { "src/a.ts": "1\n2\n3\n4\n5\n", "src/b.ts": "1\n2\n3\n" });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ file: "src/a.ts", line: 4, origin: "check", confidence: 1, ruleId: "short", severity: "medium", type: "style" });
    expect(out.ran).toEqual(["short"]);
  });
  it("respects scope and exclude", async () => {
    const big = "1\n2\n3\n4\n";
    const out = await run([r], { "src/gen/x.ts": big, "lib/y.ts": big });
    expect(out.findings).toEqual([]);
  });
  it("is skipped without a workspace", async () => {
    const out = await run([r], { "src/a.ts": "1\n2\n3\n4\n" }, undefined, false);
    expect(out.skipped).toEqual([{ ruleId: "short", reason: "needs-workspace" }]);
    expect(out.ran).toEqual([]);
  });
  it("uses the rule severity and type", async () => {
    const out = await run([rule({ id: "s", check: "max-lines: 1", severity: "high", type: "logic" })], { "a.ts": "1\n2\n" });
    expect(out.findings[0]).toMatchObject({ severity: "high", type: "logic" });
  });
});

describe("colocated-test", () => {
  const r = rule({ id: "tests", check: "colocated-test", scope: ["src/**"], exclude: ["src/i18n/**"] });
  const logic = "export function f(a: number) {\n  return a + 1;\n}\n";
  it("flags a source file without a sibling test", async () => {
    const out = await run([r], { "src/a.ts": logic });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ file: "src/a.ts", line: 1 });
  });
  it("accepts foo.test.ts, foo.spec.tsx and a test added in the same PR", async () => {
    expect((await run([r], { "src/a.ts": logic, "src/a.test.ts": "x" }, { "src/a.ts": logic })).findings).toEqual([]);
    expect((await run([r], { "src/b.tsx": logic, "src/b.spec.tsx": "x" }, { "src/b.tsx": logic })).findings).toEqual([]);
    expect((await run([r], { "src/c.ts": logic, "src/c.test.ts": "x" })).findings).toEqual([]);
  });
  it("ignores tests, .d.ts, non-source files, excluded paths", async () => {
    const out = await run([r], { "src/a.test.ts": logic, "src/types.d.ts": "declare const x: number;", "src/readme.md": "hi", "src/i18n/es.ts": logic });
    expect(out.findings).toEqual([]);
  });
  it("ignores files without logic (types, reexports, constants)", async () => {
    const files = {
      "src/types.ts": "export interface A {\n  a: string;\n}\nexport type B =\n  | 'x'\n  | 'y';\n",
      "src/index.ts": "export * from './a';\nexport { b } from './b';\n",
      "src/consts.ts": "export const MAX = 5;\nexport const NAMES = ['a', 'b'] as const;\n",
    };
    expect((await run([r], files)).findings).toEqual([]);
  });
  it("hasLogic tells logic from declarations", () => {
    expect(hasLogic("export const f = () => 1;")).toBe(true);
    expect(hasLogic("export const x = compute();")).toBe(true);
    expect(hasLogic("// only a comment\nexport type T = { a: (x: number) => void };")).toBe(false);
    expect(hasLogic("import a from 'a';\nexport default function App() { return null }")).toBe(true);
  });
});

describe("forbid-import", () => {
  const r = rule({ id: "layers", check: "forbid-import: **/repositories/**", scope: ["src/components/**"] });
  it("flags added imports matching the glob, in scope only", async () => {
    const out = await run([r], {
      "src/components/A.tsx": "import x from '../repositories/cases';\nimport y from 'react';\nconst z = require('../../repositories/z');\n",
      "src/lib/B.ts": "import x from '../repositories/cases';\n",
    });
    expect(out.findings.map((f) => `${f.file}:${f.line}`)).toEqual(["src/components/A.tsx:1", "src/components/A.tsx:3"]);
  });
  it("substring pattern ignores context lines", async () => {
    const sub = rule({ id: "sub", check: "forbid-import: lodash" });
    const out = await runChecks({
      rules: [sub],
      files: parseUnifiedDiff("--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,3 @@\n import old from 'lodash';\n+import ok from 'react';\n+import _ from 'lodash/fp';\n"),
    });
    expect(out.findings.map((f) => f.line)).toEqual([3]);
  });
  it("helpers", () => {
    expect(importSpecifiers("import { a } from \"x\"; import('y'); require('z')").sort()).toEqual(["x", "y", "z"]);
    expect(importMatches("**/repositories/**", "../repositories/a")).toBe(true);
    expect(importMatches("**/repositories/**", "react")).toBe(false);
  });
});

describe("forbid-pattern", () => {
  it("matches added lines only", async () => {
    const r = rule({ id: "accents", check: "forbid-pattern: [áéíóúñ¿¡]", exclude: ["src/i18n/**", "**/*.test.ts"] });
    const out = await runChecks({
      rules: [r],
      files: parseUnifiedDiff("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,3 @@\n // viejo comentario á\n+// nuevo comentario ñ\n+const a = 1;\n"),
    });
    expect(out.findings.map((f) => [f.file, f.line])).toEqual([["src/a.ts", 2]]);
    const ex = await run([r], { "src/i18n/es.ts": "const a = 'ñ';\n", "src/a.test.ts": "// ñ\n" });
    expect(ex.findings).toEqual([]);
  });
  it("only: comments / strings / code", async () => {
    const src = ["const label = 'ñu';", "// comentario ñ", "const ñ = `t ${x} ñ`; /* ñ */", "/*", " * ñ multi", " */"].join("\n") + "\n";
    const findLines = async (only: string) => (await run([rule({ id: "p", check: `forbid-pattern(${only}): ñ` })], { "src/a.ts": src })).findings.map((f) => f.line);
    expect(await findLines("comments")).toEqual([2, 3, 5]);
    expect(await findLines("strings")).toEqual([1, 3]);
    expect(await findLines("code")).toEqual([3]);
  });
  it("only: skips non-JS files and needs a workspace", async () => {
    const r = rule({ id: "p", check: "forbid-pattern(comments): ñ" });
    expect((await run([r], { "a.md": "ñ\n" })).findings).toEqual([]);
    expect((await run([r], { "a.ts": "// ñ\n" }, undefined, false)).skipped).toEqual([{ ruleId: "p", reason: "needs-workspace" }]);
  });
  it("maskLines keeps columns", () => {
    expect(maskLines("a // b\n'c'", "comment")).toEqual(["  // b", "   "]);
  });
});

describe("runChecks in general", () => {
  it("ignores rules without check, inactive rules and invalid checks; output is deterministic", async () => {
    const rules = [
      rule({ id: "none" }),
      rule({ id: "off", check: "max-lines: 1", status: "suggested" }),
      rule({ id: "bad", check: "max-lines: nope" }),
      rule({ id: "b-rule", check: "max-lines: 1" }),
      rule({ id: "a-rule", check: "max-lines: 1" }),
    ];
    const files = { "z.ts": "1\n2\n", "a.ts": "1\n2\n" };
    const a = await run(rules, files);
    const b = await run([...rules].reverse(), files);
    expect(a.findings).toEqual(b.findings);
    expect(a.findings.map((f) => `${f.file}/${f.ruleId}`)).toEqual(["a.ts/a-rule", "a.ts/b-rule", "z.ts/a-rule", "z.ts/b-rule"]);
    expect(a.skipped).toEqual([{ ruleId: "bad", reason: "invalid-check" }]);
  });
});
