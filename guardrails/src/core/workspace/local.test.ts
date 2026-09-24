import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

workspaceContract("LocalWorkspace", () => ({ ws, outside }));

describe("LocalWorkspace: links", () => {
  it("rejects a directory link pointing outside the repo", async (ctx) => {
    if (!dirLinkOk) ctx.skip(); // cannot create the link on this machine
    await expect(ws.readFile({ path: "link-dir/secret.txt" })).rejects.toThrow(/outside/);
  });

  it("rejects a file symlink pointing outside the repo", async (ctx) => {
    if (!fileLinkOk) ctx.skip(); // Windows: file symlinks require privileges
    await expect(ws.readFile({ path: "link-file" })).rejects.toThrow(/outside/);
  });
});
