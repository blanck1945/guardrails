import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Workspace } from "./types";

/** The tiny repo every `Workspace` implementation is tested against. */
export const FIXTURE_BASE: Record<string, string> = {
  "big.txt": Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  "src/a.ts": "export function foo() {\n  return 1;\n}\n",
  "src/b.ts": "import { foo } from './a';\nfoo();\n",
  "many.txt": Array.from({ length: 100 }, (_, i) => `needle ${i}`).join("\n") + "\n",
};
export const FIXTURE_HEAD: Record<string, string> = {
  ...FIXTURE_BASE,
  "src/a.ts": "export function foo(x: number) {\n  return x;\n}\n",
};
export const FIXTURE_DIFF = "--- a/src/a.ts\n+++ b/src/a.ts\n-export function foo() {\n+export function foo(x: number) {\n";

export interface ContractFixture {
  ws: Workspace;
  /** Directory outside the repo that contains `secret.txt`. */
  outside: string;
}

/** Behaviour every `Workspace` must share (limits, formats, path safety). */
export function workspaceContract(name: string, get: () => ContractFixture): void {
  describe(`${name}: Workspace contract`, () => {
    describe("readFile", () => {
      it("returns the requested range with line numbers", async () => {
        const r = await get().ws.readFile({ path: "big.txt", startLine: 10, endLine: 12 });
        expect(r.content).toBe("10\tline 10\n11\tline 11\n12\tline 12");
        expect([r.startLine, r.endLine, r.totalLines, r.truncated]).toEqual([10, 12, 500, false]);
      });

      it("caps a single read at 300 lines", async () => {
        const r = await get().ws.readFile({ path: "big.txt", startLine: 1, endLine: 500 });
        expect(r.endLine).toBe(300);
        expect(r.truncated).toBe(true);
        expect(r.content.split("\n")).toHaveLength(300);
      });

      it("reads head and base versions", async () => {
        const { ws } = get();
        const head = await ws.readFile({ path: "src/a.ts", ref: "head" });
        const base = await ws.readFile({ path: "src/a.ts", ref: "base" });
        expect(head.content).toContain("foo(x: number)");
        expect(base.content).toContain("foo()");
      });

      it("errors on missing file", async () => {
        await expect(get().ws.readFile({ path: "nope.txt" })).rejects.toThrow();
      });
    });

    describe("grep", () => {
      it("caps results at 60", async () => {
        const r = await get().ws.grep({ pattern: "needle" });
        expect(r.matches).toHaveLength(60);
        expect(r.truncated).toBe(true);
        expect(r.matches[0]).toMatch(/^many\.txt:\d+:needle/);
      });

      it("supports fixed, ignoreCase and pathGlob, and does not treat the pattern as shell", async () => {
        const { ws } = get();
        const r = await ws.grep({ pattern: "FOO(", fixed: true, ignoreCase: true, pathGlob: "src/*.ts" });
        expect(r.matches.map((m) => m.split(":")[0]).sort()).toEqual(["src/a.ts", "src/b.ts"]);
        const injected = await ws.grep({ pattern: "x; echo pwned > pwned.txt", fixed: true });
        expect(injected.matches).toEqual([]);
      });
    });

    describe("listFiles / diff / findReferencesByName", () => {
      it("lists tracked files filtered by glob", async () => {
        const r = await get().ws.listFiles({ glob: "src/**/*.ts" });
        expect(r.files).toEqual(["src/a.ts", "src/b.ts"]);
      });

      it("returns the base..head diff", async () => {
        expect(await get().ws.diff()).toContain("+export function foo(x: number)");
      });

      it("finds references by whole-word name", async () => {
        const r = await get().ws.findReferencesByName({ symbol: "foo" });
        expect(r.references.map((x) => x.path)).toContain("src/b.ts");
        expect(r.references.every((x) => x.confidence === "name")).toBe(true);
      });
    });

    describe("path escape", () => {
      it("rejects ../x", async () => {
        const { ws } = get();
        await expect(ws.readFile({ path: "../outside/secret.txt" })).rejects.toThrow(/escapes/);
        await expect(ws.readFile({ path: "src/../../outside/secret.txt", ref: "base" })).rejects.toThrow(/escapes/);
      });

      it("rejects absolute paths", async () => {
        const { ws, outside } = get();
        await expect(ws.readFile({ path: "/etc/passwd" })).rejects.toThrow(/absolute/);
        await expect(ws.readFile({ path: path.join(outside, "secret.txt") })).rejects.toThrow(/absolute/);
      });
    });
  });
}
