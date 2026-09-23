import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalWorkspace } from "./local";

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

let tmp: string;
let repo: string;
let outside: string;
let baseSha: string;
let dirLinkOk = false;
let fileLinkOk = false;
let ws: LocalWorkspace;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "ws-test-"));
  repo = path.join(tmp, "repo");
  outside = path.join(tmp, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "top secret\n");
  git(repo, "init", "-q");
  git(repo, "config", "core.autocrlf", "false");

  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  writeFileSync(path.join(repo, "big.txt"), lines);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "a.ts"), "export function foo() {\n  return 1;\n}\n");
  writeFileSync(path.join(repo, "src", "b.ts"), "import { foo } from './a';\nfoo();\n");
  writeFileSync(path.join(repo, "many.txt"), Array.from({ length: 100 }, (_, i) => `needle ${i}`).join("\n") + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  baseSha = git(repo, "rev-parse", "HEAD");

  writeFileSync(path.join(repo, "src", "a.ts"), "export function foo(x: number) {\n  return x;\n}\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "head");
  // Links are created untracked after the commits: LocalWorkspace reads the working tree.
  try {
    // "junction" needs no privileges on Windows and is ignored on POSIX (behaves as "dir").
    symlinkSync(outside, path.join(repo, "link-dir"), "junction");
    dirLinkOk = true;
  } catch {
    dirLinkOk = false;
  }
  try {
    symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "link-file"), "file");
    fileLinkOk = true;
  } catch {
    fileLinkOk = false; // Windows without developer mode / admin
  }
  ws = new LocalWorkspace({ root: repo, baseRef: baseSha });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readFile", () => {
  it("returns the requested range with line numbers", async () => {
    const r = await ws.readFile({ path: "big.txt", startLine: 10, endLine: 12 });
    expect(r.content).toBe("10\tline 10\n11\tline 11\n12\tline 12");
    expect([r.startLine, r.endLine, r.totalLines, r.truncated]).toEqual([10, 12, 500, false]);
  });

  it("caps a single read at 300 lines", async () => {
    const r = await ws.readFile({ path: "big.txt", startLine: 1, endLine: 500 });
    expect(r.endLine).toBe(300);
    expect(r.truncated).toBe(true);
    expect(r.content.split("\n")).toHaveLength(300);
  });

  it("reads head and base versions", async () => {
    const head = await ws.readFile({ path: "src/a.ts", ref: "head" });
    const base = await ws.readFile({ path: "src/a.ts", ref: "base" });
    expect(head.content).toContain("foo(x: number)");
    expect(base.content).toContain("foo()");
  });

  it("errors on missing file", async () => {
    await expect(ws.readFile({ path: "nope.txt" })).rejects.toThrow();
  });
});

describe("grep", () => {
  it("caps results at 60", async () => {
    const r = await ws.grep({ pattern: "needle" });
    expect(r.matches).toHaveLength(60);
    expect(r.truncated).toBe(true);
    expect(r.matches[0]).toMatch(/^many\.txt:\d+:needle/);
  });

  it("supports fixed, ignoreCase and pathGlob, and does not treat the pattern as shell", async () => {
    const r = await ws.grep({ pattern: "FOO(", fixed: true, ignoreCase: true, pathGlob: "src/*.ts" });
    expect(r.matches.map((m) => m.split(":")[0]).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const injected = await ws.grep({ pattern: "x; echo pwned > pwned.txt", fixed: true });
    expect(injected.matches).toEqual([]);
  });
});

describe("listFiles / diff / findReferencesByName", () => {
  it("lists tracked files filtered by glob", async () => {
    const r = await ws.listFiles({ glob: "src/**/*.ts" });
    expect(r.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns the base..head diff", async () => {
    const d = await ws.diff();
    expect(d).toContain("+export function foo(x: number)");
  });

  it("finds references by whole-word name", async () => {
    const r = await ws.findReferencesByName({ symbol: "foo" });
    expect(r.references.map((x) => x.path)).toContain("src/b.ts");
    expect(r.references.every((x) => x.confidence === "name")).toBe(true);
  });
});

describe("path escape", () => {
  it("rejects ../x", async () => {
    await expect(ws.readFile({ path: "../outside/secret.txt" })).rejects.toThrow(/escapes/);
    await expect(ws.readFile({ path: "src/../../outside/secret.txt", ref: "base" })).rejects.toThrow(/escapes/);
  });

  it("rejects absolute paths", async () => {
    await expect(ws.readFile({ path: "/etc/passwd" })).rejects.toThrow(/absolute/);
    await expect(ws.readFile({ path: path.join(outside, "secret.txt") })).rejects.toThrow(/absolute/);
  });

  it("rejects a directory link pointing outside the repo", async (ctx) => {
    if (!dirLinkOk) ctx.skip(); // cannot create the link on this machine
    await expect(ws.readFile({ path: "link-dir/secret.txt" })).rejects.toThrow(/outside/);
  });

  it("rejects a file symlink pointing outside the repo", async (ctx) => {
    if (!fileLinkOk) ctx.skip(); // Windows: file symlinks require privileges
    await expect(ws.readFile({ path: "link-file" })).rejects.toThrow(/outside/);
  });
});
