import { mkdirSync, mkdtempSync, readdirSync, existsSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceContract, FIXTURE_BASE, FIXTURE_DIFF, FIXTURE_HEAD } from "./contract";
import {
  RepoTooLargeError,
  TarballDownloadError,
  TarballWorkspace,
  downloadRepoTarball,
  extractTarball,
  type TarballOctokit,
} from "./tarball";
import { makeTarball, tarballOf } from "./tarball-test-utils";

let tmp: string;
let n = 0;
const fresh = (label = "d") => path.join(tmp, `${label}-${n++}`);

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "tarball-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function listTree(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listTree(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}

/** Octokit stand-in: serves tarballs by ref and records the calls. */
function fakeOctokit(byRef: Record<string, Buffer | Error>) {
  const calls: { route: string; ref: string }[] = [];
  const octokit: TarballOctokit = {
    async request(route, params) {
      calls.push({ route, ref: String(params.ref) });
      const v = byRef[String(params.ref)];
      if (!v) throw Object.assign(new Error("not found"), { status: 404 });
      if (v instanceof Error) throw v;
      return { data: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) };
    },
  };
  return { octokit, calls };
}

describe("extractTarball", () => {
  it("extracts regular files with strip 1 and applies the filters", async () => {
    const dest = fresh();
    const tarball = makeTarball([
      { path: "owner-repo-abc/", type: "Directory" },
      { path: "owner-repo-abc/src/a.ts", content: "export const a = 1;\n" },
      { path: "owner-repo-abc/README.md", content: "# hi\n" },
      { path: "owner-repo-abc/big.txt", content: Buffer.alloc(1024 * 1024 + 1, "x") },
      { path: "owner-repo-abc/node_modules/dep/index.js", content: "x" },
      { path: "owner-repo-abc/packages/x/node_modules/y.js", content: "x" },
      { path: "owner-repo-abc/.git/config", content: "x" },
      { path: "owner-repo-abc/dist/out.js", content: "x" },
      { path: "owner-repo-abc/pnpm-lock.yaml", content: "x" },
      { path: "owner-repo-abc/link", type: "SymbolicLink", linkpath: "/etc/passwd" },
      { path: "owner-repo-abc/hard", type: "Link", linkpath: "owner-repo-abc/README.md" },
      { path: "owner-repo-abc/../evil.txt", content: "evil" },
      { path: "/abs-evil.txt", content: "evil" },
    ]);
    const stats = await extractTarball(tarball, dest);
    expect(listTree(dest)).toEqual(["README.md", "src/a.ts"]);
    expect(readFileSync(path.join(dest, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(stats.files).toBe(2);
    expect(stats.skipped).toMatchObject({ large: 1, links: 2, rejected: 2, ignored: 5 });
    expect(stats.omittedLarge).toEqual(["big.txt"]);
    // nothing escaped
    expect(existsSync(path.join(dest, "..", "evil.txt"))).toBe(false);
    expect(existsSync(path.join(path.parse(dest).root, "abs-evil.txt"))).toBe(false);
  });

  it("throws RepoTooLargeError past the file count", async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, "x"]));
    const err = await extractTarball(tarballOf(files), fresh(), { maxFiles: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(RepoTooLargeError);
    expect(err.reason).toBe("files");
  });

  it("throws RepoTooLargeError past the byte total", async () => {
    const files = { "a.txt": "x".repeat(600), "b.txt": "x".repeat(600) };
    const err = await extractTarball(tarballOf(files), fresh(), { maxBytes: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(RepoTooLargeError);
    expect(err.reason).toBe("bytes");
  });

  it("does not count ignored content against the caps", async () => {
    const stats = await extractTarball(tarballOf({ "a.txt": "x", "node_modules/z.js": "y".repeat(300) }), fresh(), { maxBytes: 100 });
    expect(stats.files).toBe(1);
  });

  it("fails cleanly on data that is not a tarball", async () => {
    await expect(extractTarball(Buffer.from("this is not a tar file at all, just text"), fresh())).rejects.toThrow();
  });
});

describe("downloadRepoTarball", () => {
  const base = { owner: "o", repo: "r" };

  it("requests the tarball route with the ref and extracts it", async () => {
    const { octokit, calls } = fakeOctokit({ abc: tarballOf({ "a.txt": "hello\n" }) });
    const dest = fresh();
    const stats = await downloadRepoTarball({ ...base, octokit, ref: "abc", destDir: dest });
    expect(calls).toEqual([{ route: "GET /repos/{owner}/{repo}/tarball/{+ref}", ref: "abc" }]);
    expect(stats.files).toBe(1);
    expect(listTree(dest)).toEqual(["a.txt"]);
  });

  it("times out with an AbortSignal", async () => {
    const octokit: TarballOctokit = {
      request: (_r, params) =>
        new Promise((_, reject) => {
          const signal = (params.request as { signal: AbortSignal }).signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const err = await downloadRepoTarball({ ...base, octokit, ref: "x", destDir: fresh(), limits: { timeoutMs: 20 } }).catch((e) => e);
    expect(err).toBeInstanceOf(TarballDownloadError);
    expect(err.kind).toBe("timeout");
  });

  it("maps other failures to TarballDownloadError without leaking the cause", async () => {
    const { octokit } = fakeOctokit({ x: new Error("secret-token-123 leaked here") });
    const err = await downloadRepoTarball({ ...base, octokit, ref: "x", destDir: fresh() }).catch((e) => e);
    expect(err).toBeInstanceOf(TarballDownloadError);
    expect(err.kind).toBe("failed");
    expect(String(err.message)).not.toContain("secret");
  });

  it("rejects a download above the size cap", async () => {
    const { octokit } = fakeOctokit({ x: tarballOf({ "a.txt": "x".repeat(2000) }) });
    const err = await downloadRepoTarball({ ...base, octokit, ref: "x", destDir: fresh(), limits: { maxBytes: 10 } }).catch((e) => e);
    expect(err).toBeInstanceOf(RepoTooLargeError);
  });
});

describe("TarballWorkspace.create", () => {
  const args = { owner: "o", repo: "r", baseRef: "basesha", headRef: "refs/pull/7/head" };

  it("downloads base and head into a private random dir and disposes it", async () => {
    const parent = fresh("parent");
    mkdirSync(parent);
    const { octokit, calls } = fakeOctokit({
      basesha: tarballOf(FIXTURE_BASE),
      "refs/pull/7/head": tarballOf({ ...FIXTURE_HEAD, "src/new.ts": "export const created = 1;\n" }),
    });
    const ws = await TarballWorkspace.create({ ...args, octokit, tmpRoot: parent, diff: FIXTURE_DIFF });
    expect(calls.map((c) => c.ref).sort()).toEqual(["basesha", "refs/pull/7/head"]);
    const [root] = readdirSync(parent);
    expect(root).toMatch(/^guardrails-[0-9a-f]{24}$/);
    if (process.platform !== "win32") expect(statSync(path.join(parent, root)).mode & 0o777).toBe(0o700);

    // base vs head
    expect((await ws.readFile({ path: "src/a.ts", ref: "base" })).content).toContain("foo()");
    expect((await ws.readFile({ path: "src/a.ts" })).content).toContain("foo(x: number)");
    expect((await ws.listFiles({ ref: "base", glob: "src/*.ts" })).files).toEqual(["src/a.ts", "src/b.ts"]);
    expect((await ws.listFiles({ ref: "head", glob: "src/*.ts" })).files).toEqual(["src/a.ts", "src/b.ts", "src/new.ts"]);
    expect(await ws.listFiles({ glob: "src/*.ts", limit: 1 })).toEqual({ files: ["src/a.ts"], truncated: true });
    await expect(ws.readFile({ path: "src/new.ts", ref: "base" })).rejects.toThrow(/not found/);
    expect(await ws.diff()).toBe(FIXTURE_DIFF);

    await ws.dispose();
    expect(existsSync(path.join(parent, root))).toBe(false);
    await ws.dispose(); // idempotent
    await expect(ws.readFile({ path: "big.txt" })).rejects.toThrow(/disposed/);
  });

  it("removes the temp dir when a download fails", async () => {
    const parent = fresh("parent");
    mkdirSync(parent);
    const { octokit } = fakeOctokit({ basesha: tarballOf(FIXTURE_BASE) }); // head missing -> 404
    await expect(TarballWorkspace.create({ ...args, octokit, tmpRoot: parent })).rejects.toBeInstanceOf(TarballDownloadError);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("propagates RepoTooLargeError and cleans up", async () => {
    const parent = fresh("parent");
    mkdirSync(parent);
    const big = tarballOf(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}`, "x"])));
    const { octokit } = fakeOctokit({ basesha: big, "refs/pull/7/head": big });
    await expect(
      TarballWorkspace.create({ ...args, octokit, tmpRoot: parent, limits: { maxFiles: 3 } }),
    ).rejects.toBeInstanceOf(RepoTooLargeError);
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("TarballWorkspace behaviour", () => {
  let ws: TarballWorkspace;
  const build = async (head: Buffer, opts: { grepBudgetMs?: number } = {}) => {
    const { octokit } = fakeOctokit({ b: tarballOf(FIXTURE_BASE), h: head });
    return TarballWorkspace.create({ octokit, owner: "o", repo: "r", baseRef: "b", headRef: "h", tmpRoot: tmp, ...opts });
  };

  beforeAll(async () => {
    ws = await build(
      makeTarball([
        { path: "x/", type: "Directory" },
        { path: "x/src/a.ts", content: FIXTURE_HEAD["src/a.ts"] },
        { path: "x/src/b.ts", content: FIXTURE_HEAD["src/b.ts"] },
        { path: "x/link", type: "SymbolicLink", linkpath: "/etc/passwd" },
        { path: "x/huge.txt", content: Buffer.alloc(1024 * 1024 + 10, "a") },
        { path: "x/bin.dat", content: Buffer.from([1, 2, 0, 3]) },
        { path: "x/long.txt", content: `needle ${"z".repeat(400)}\n` },
        { path: "x/util.ts", content: "const fooBar = 1;\nconst foo = fooBar + 1;\n// foo_baz\n" },
      ]),
    );
  });
  afterAll(async () => {
    await ws.dispose();
  });

  it("does not expose symlinks, and explains omitted large files", async () => {
    expect((await ws.listFiles()).files).not.toContain("link");
    await expect(ws.readFile({ path: "link" })).rejects.toThrow(/not found/);
    await expect(ws.readFile({ path: "huge.txt" })).rejects.toThrow(/omitted/);
  });

  it("refuses binary files and skips them in grep", async () => {
    await expect(ws.readFile({ path: "bin.dat" })).rejects.toThrow(/binary/);
    expect((await ws.grep({ pattern: "\\x01" })).matches).toEqual([]);
  });

  it("greps with a regex and with a literal", async () => {
    const re = await ws.grep({ pattern: "function\\s+foo\\(x", pathGlob: "src/*.ts" });
    expect(re.matches).toEqual(["src/a.ts:1:export function foo(x: number) {"]);
    const lit = await ws.grep({ pattern: "foo(", fixed: true });
    expect(lit.matches.map((m) => m.split(":")[0]).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // a regex metacharacter is literal in fixed mode
    expect((await ws.grep({ pattern: "a.b", fixed: true })).matches).toEqual([]);
  });

  it("truncates long lines to 200 chars", async () => {
    const r = await ws.grep({ pattern: "needle", fixed: true });
    expect(r.matches[0].endsWith("...")).toBe(true);
    expect(r.matches[0].length).toBe(203);
  });

  it("rejects catastrophic and oversized patterns and invalid regex", async () => {
    await expect(ws.grep({ pattern: "(a+)+$" })).rejects.toThrow(/rejected/);
    await expect(ws.grep({ pattern: "(x*)*y" })).rejects.toThrow(/rejected/);
    await expect(ws.grep({ pattern: "a".repeat(201) })).rejects.toThrow(/too long/);
    await expect(ws.grep({ pattern: "(" })).rejects.toThrow(/invalid/);
    // the same catastrophic text is fine as a literal
    await expect(ws.grep({ pattern: "(a+)+$", fixed: true })).resolves.toEqual({ matches: [], truncated: false });
  });

  it("stops at the time budget between files", async () => {
    const slow = await build(tarballOf(FIXTURE_HEAD), { grepBudgetMs: 0 });
    try {
      expect(await slow.grep({ pattern: "needle" })).toEqual({ matches: [], truncated: true });
    } finally {
      await slow.dispose();
    }
  });

  it("finds references by whole word only", async () => {
    const r = await ws.findReferencesByName({ symbol: "foo" });
    const found = r.references.map((x) => `${x.path}:${x.line}`).sort();
    expect(found).toEqual(["src/a.ts:1", "src/b.ts:1", "src/b.ts:2", "util.ts:2"]); // not fooBar / foo_baz
  });
});

describe("TarballWorkspace path safety", () => {
  it("rejects a path that resolves outside the tree", async () => {
    const { octokit } = fakeOctokit({ b: tarballOf(FIXTURE_BASE), h: tarballOf(FIXTURE_HEAD) });
    const ws = await TarballWorkspace.create({ octokit, owner: "o", repo: "r", baseRef: "b", headRef: "h", tmpRoot: tmp });
    try {
      await expect(ws.readFile({ path: "../base/big.txt", ref: "head" })).rejects.toThrow(/escapes/);
    } finally {
      await ws.dispose();
    }
  });
});

// Shared suite: same behaviour as LocalWorkspace.
let contractWs: TarballWorkspace;
let outsideDir: string;
beforeAll(async () => {
  outsideDir = fresh("outside");
  mkdirSync(outsideDir);
  const { octokit } = fakeOctokit({ b: tarballOf(FIXTURE_BASE), h: tarballOf(FIXTURE_HEAD) });
  contractWs = await TarballWorkspace.create({ octokit, owner: "o", repo: "r", baseRef: "b", headRef: "h", tmpRoot: tmp, diff: FIXTURE_DIFF });
});
afterAll(async () => {
  await contractWs.dispose();
});
workspaceContract("TarballWorkspace", () => ({ ws: contractWs, outside: outsideDir }));
