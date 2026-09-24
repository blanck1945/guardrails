import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHookScript, HOOK_MARKER, installHook, prePushPath, uninstallHook } from "./hook";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string) {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function makeRepo() {
  const repo = tmp("guardrails-hook-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  return repo;
}
const TOOL = "/opt/guardrails";
const read = (p: string) => readFileSync(p, "utf8");

describe("hook installer", () => {
  it("installs an executable pre-push hook and uninstalls it", async () => {
    const repo = makeRepo();
    const r = await installHook(repo, TOOL);
    expect(r.status).toBe("installed");
    const hook = await prePushPath(repo);
    expect(hook).toBe(path.resolve(repo, ".git/hooks/pre-push"));
    const text = read(hook);
    expect(text).toContain(HOOK_MARKER);
    expect(text).toContain("GUARDRAILS_SKIP");
    expect(text).toContain(`TOOL_DIR='${TOOL}'`);
    expect(text).toContain("review");

    expect((await installHook(repo, TOOL)).status).toBe("updated");
    expect((await uninstallHook(repo)).status).toBe("uninstalled");
    expect(existsSync(hook)).toBe(false);
    expect((await uninstallHook(repo)).status).toBe("not-installed");
  });

  it("does not overwrite a foreign hook: chains it and restores it on uninstall", async () => {
    const repo = makeRepo();
    const hook = path.join(repo, ".git/hooks/pre-push");
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho mine\n");
    chmodSync(hook, 0o755);

    const r = await installHook(repo, TOOL);
    expect(r.status).toBe("chained");
    expect(read(hook + ".pre-guardrails")).toContain("echo mine");
    expect(read(hook)).toContain(HOOK_MARKER);

    expect((await uninstallHook(repo)).status).toBe("restored");
    expect(read(hook)).toBe("#!/bin/sh\necho mine\n");
    expect(existsSync(hook + ".pre-guardrails")).toBe(false);
  });

  it("refuses when a chained hook is already stored", async () => {
    const repo = makeRepo();
    const hook = path.join(repo, ".git/hooks/pre-push");
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\n");
    writeFileSync(hook + ".pre-guardrails", "#!/bin/sh\n");
    expect((await installHook(repo, TOOL)).status).toBe("refused");
    expect(read(hook)).toBe("#!/bin/sh\n");
  });

  it("honors core.hooksPath", async () => {
    const repo = makeRepo();
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: repo });
    const r = await installHook(repo, TOOL);
    expect(r.hookPath).toBe(path.resolve(repo, ".githooks/pre-push"));
    expect(existsSync(r.hookPath)).toBe(true);
  });

  it("fails clearly outside a git repository", async () => {
    await expect(installHook(tmp("guardrails-nogit-"), TOOL)).rejects.toThrow(/not a git repository/);
  });
});

// Behavior of the generated script, with a fake `node` standing in for the real CLI (needs `sh`).
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
describe.skipIf(!hasSh)("generated hook script", () => {
  const posix = (p: string) => p.replace(/\\/g, "/");
  function setup(exitCode: number) {
    const tool = tmp("guardrails-fake-tool-");
    mkdirSync(path.join(tool, "src/cli"), { recursive: true });
    writeFileSync(path.join(tool, "src/cli/guardrails.ts"), "");
    const bin = tmp("guardrails-fake-bin-");
    writeFileSync(path.join(bin, "node"), `#!/bin/sh\necho "$@" >> "${posix(tool)}/calls.log"\nexit ${exitCode}\n`);
    chmodSync(path.join(bin, "node"), 0o755);
    const script = path.join(tool, "pre-push");
    writeFileSync(script, buildHookScript(tool));
    chmodSync(script, 0o755);
    return { tool, bin, script, repo: makeRepo() };
  }
  const ZERO = "0".repeat(40);
  const run = (s: ReturnType<typeof setup>, stdin: string, env: Record<string, string> = {}) =>
    spawnSync("sh", [posix(s.script), "origin", "url"], {
      cwd: s.repo,
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, PATH: `${s.bin}${path.delimiter}${process.env.PATH}`, ...env },
    });

  it("blocks only on the findings exit code (42)", () => {
    const s = setup(42);
    const r = run(s, `refs/heads/x ${"a".repeat(40)} refs/heads/x ${ZERO}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("push blocked");
  });

  it("lets the push through when the review cannot run (any other exit code)", () => {
    const s = setup(2);
    const r = run(s, `refs/heads/x ${"a".repeat(40)} refs/heads/x ${ZERO}\n`);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("push allowed");
  });

  it("passes the pushed head sha, skips deletions and honors GUARDRAILS_SKIP=1", () => {
    const s = setup(0);
    const sha = "b".repeat(40);
    expect(run(s, `refs/heads/x ${sha} refs/heads/x ${ZERO}\n(delete) ${ZERO} refs/heads/y ${sha}\n`).status).toBe(0);
    const log = read(path.join(s.tool, "calls.log"));
    expect(log).toContain(`--head ${sha}`);
    expect(log.trim().split("\n")).toHaveLength(1); // deletion skipped
    expect(log).not.toContain("--base"); // new branch: default base

    const s2 = setup(42);
    expect(run(s2, `refs/heads/x ${sha} refs/heads/x ${ZERO}\n`, { GUARDRAILS_SKIP: "1" }).status).toBe(0);
    expect(existsSync(path.join(s2.tool, "calls.log"))).toBe(false);
  });
});
