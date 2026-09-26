import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceContract } from "./contract";
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
  // A symlink committed in the head tree (created with plumbing so it works on any OS): must never be followed.
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "../outside/secret.txt", encoding: "utf8" }).trim();
  git(repo, "update-index", "--add", "--cacheinfo", `120000,${blob},link-file`);
  git(repo, "commit", "-q", "-m", "link");
  ws = new LocalWorkspace({ root: repo, baseRef: baseSha });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

workspaceContract("LocalWorkspace", () => ({ ws, outside }));

describe("LocalWorkspace: links", () => {
  it("rejects a symlink of the head tree", async () => {
    await expect(ws.readFile({ path: "link-file" })).rejects.toThrow(/symlink|outside/);
  });

  it("does not list or search symlinks", async () => {
    expect((await ws.listFiles()).files).not.toContain("link-file");
    expect((await ws.grep({ pattern: "secret", fixed: true })).matches).toEqual([]);
  });

  it("an untracked link in the working tree is not visible", async () => {
    await expect(ws.readFile({ path: "not-in-head.txt" })).rejects.toThrow(/not found/);
  });
});

describe("LocalWorkspace: head reads come from the head revision (v0.7.4)", () => {
  let dir: string;
  let headSha: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ws-head-"));
    git(dir, "init", "-q");
    git(dir, "config", "core.autocrlf", "false");
    writeFileSync(path.join(dir, "a.ts"), "export const marker = 'base';\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "branch", "-M", "base71");
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(path.join(dir, "a.ts"), "export const marker = 'headmark';\nexport function headOnly() {}\n");
    writeFileSync(path.join(dir, "only-head.ts"), "headOnly();\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "head");
    headSha = git(dir, "rev-parse", "feature");
    // Check the base branch out and add an uncommitted edit: the working tree now differs from the head.
    git(dir, "checkout", "-q", "base71");
    writeFileSync(path.join(dir, "a.ts"), "export const marker = 'dirty';\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const make = (headRef: string) => new LocalWorkspace({ root: dir, baseRef: "base71", headRef });

  it("readFile returns the head content, not the working tree", async () => {
    for (const ref of ["feature", headSha]) {
      const r = await make(ref).readFile({ path: "a.ts" });
      expect(r.content).toContain("headmark");
      expect(r.content).not.toContain("dirty");
    }
    expect((await make("feature").readFile({ path: "only-head.ts" })).content).toContain("headOnly");
    expect((await make("feature").readFile({ path: "a.ts", ref: "base" })).content).toContain("'base'");
  });

  it("grep and findReferencesByName search the head, with paths unchanged", async () => {
    const ws2 = make("feature");
    const g = await ws2.grep({ pattern: "headmark", fixed: true });
    expect(g.matches).toEqual(["a.ts:1:export const marker = 'headmark';"]);
    expect((await ws2.grep({ pattern: "dirty", fixed: true })).matches).toEqual([]);
    const refs = await ws2.findReferencesByName({ symbol: "headOnly" });
    expect(refs.references.map((x) => x.path).sort()).toEqual(["a.ts", "only-head.ts"]);
    expect(refs.references.every((x) => !x.path.startsWith("feature"))).toBe(true);
  });

  it("listFiles lists the head tree", async () => {
    expect((await make("feature").listFiles()).files).toEqual(["a.ts", "only-head.ts"]);
    expect((await make("feature").listFiles({ ref: "base" })).files).toEqual(["a.ts"]);
  });

  it("workingTree mode (init only) still reads the checkout as it is on disk", async () => {
    const w = new LocalWorkspace({ root: dir, workingTree: true });
    expect((await w.readFile({ path: "a.ts" })).content).toContain("dirty");
    expect((await w.grep({ pattern: "dirty", fixed: true })).matches).toEqual(["a.ts:1:export const marker = 'dirty';"]);
    expect((await w.listFiles()).files).toEqual(["a.ts"]);
  });

  it("an invalid head revision gives a clear error", async () => {
    await expect(make("no-such-branch").readFile({ path: "a.ts" })).rejects.toThrow(/invalid revision/);
    await expect(make("no-such-branch").grep({ pattern: "x" })).rejects.toThrow(/head revision/);
  });
});
