/**
 * `pnpm smoke:cloud` (opt-in: it calls a real model; skipped unless GUARDRAILS_SMOKE=1):
 * the webhook review path end to end, WITHOUT real GitHub.
 *
 * A local HTTP server emulates the GitHub endpoints the review uses (pulls.get, pulls.listFiles,
 * repos.getContent, the tarball redirect, pulls.createReview). A real Octokit client talks to it, the real
 * `reviewPullRequest` runs in agent mode through `TarballWorkspace`, and the model is REAL (one pass, capped at
 * US$0.05). Credentials come from the environment or `.env.local`; they are never printed.
 */
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Octokit } from "octokit";
import { TarballWorkspace } from "@/core/workspace";
import { makeTarball } from "@/core/workspace/tarball-test-utils";
import { reviewPullRequest, type DisposableWorkspace } from "./review-pr";
import type { Octo } from "./github";
import type { PullRequestEvent } from "./webhook";

const MAX_USD = 0.05;
const TOKEN = "fake-installation-token";

const BASE_UTIL = `export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i]!;
  }
  return total;
}
`;

// Two obvious bugs: an off-by-one loop bound and an assignment inside a condition.
const HEAD_UTIL = `export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i]!;
  }
  return total;
}

export function firstOrDefault(values: number[] | null, fallback: number): number {
  let result = fallback;
  if (values = null) {
    return result;
  }
  result = values[0] ?? fallback;
  return result;
}
`;

const INDEX = `import { firstOrDefault, sum } from "./util";

export const total = sum([1, 2, 3]);
export const first = firstOrDefault([4, 5], 0);
`;

const PATCH = [
  "@@ -1,7 +1,16 @@",
  " export function sum(values: number[]): number {",
  "   let total = 0;",
  "-  for (let i = 0; i < values.length; i++) {",
  "+  for (let i = 0; i <= values.length; i++) {",
  "     total += values[i]!;",
  "   }",
  "   return total;",
  " }",
  "+",
  "+export function firstOrDefault(values: number[] | null, fallback: number): number {",
  "+  let result = fallback;",
  "+  if (values = null) {",
  "+    return result;",
  "+  }",
  "+  result = values[0] ?? fallback;",
  "+  return result;",
  "+}",
].join("\n");

const README = "# tiny\n\nA tiny repo for the Guardrails cloud smoke test.\n";
const common = { "README.md": README, "package.json": '{ "name": "tiny", "type": "module" }\n', "src/index.ts": INDEX };
const BASE_TARBALL = makeTarball([
  { path: "o-r-basesha/", type: "Directory" },
  ...Object.entries({ ...common, "src/util.ts": BASE_UTIL }).map(([p, content]) => ({ path: `o-r-basesha/${p}`, content })),
]);
const HEAD_TARBALL = makeTarball([
  { path: "o-r-headsha/", type: "Directory" },
  ...Object.entries({ ...common, "src/util.ts": HEAD_UTIL }).map(([p, content]) => ({ path: `o-r-headsha/${p}`, content })),
]);

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}

function loadEnvLocal(): void {
  try {
    process.loadEnvFile(".env.local"); // does not override variables that are already set
  } catch {
    // no .env.local: rely on the environment
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  process.env.GUARDRAILS_MODEL ||= "zai:glm-5.3";

  const requests: string[] = [];
  let created: { body?: string; comments?: { path: string; line: number; body: string }[] } | undefined;
  let authOk = true;

  const server = createServer(async (req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname.startsWith("/repos/") && req.headers.authorization !== `token ${TOKEN}` && !url.pathname.startsWith("/codeload/")) {
      authOk = false;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const m = url.pathname;
    if (req.method === "GET" && m === "/repos/o/r/pulls/1") {
      return json(200, { title: "Add firstOrDefault", body: "Adds a helper.", base: { sha: "basesha" }, head: { sha: "headsha" } });
    }
    if (req.method === "GET" && m === "/repos/o/r/pulls/1/files") {
      return json(200, [{ filename: "src/util.ts", status: "modified", patch: PATCH }]);
    }
    if (req.method === "GET" && m === "/repos/o/r/contents/README.md") {
      return json(200, { type: "file", content: Buffer.from(README).toString("base64"), encoding: "base64" });
    }
    if (req.method === "GET" && m.startsWith("/repos/o/r/contents/")) return json(404, { message: "Not Found" });
    const tb = /^\/repos\/o\/r\/tarball\/(basesha|headsha)$/.exec(m);
    if (req.method === "GET" && tb) {
      res.writeHead(302, { location: `/codeload/${tb[1]}.tar.gz` });
      return res.end();
    }
    const cl = /^\/codeload\/(basesha|headsha)\.tar\.gz$/.exec(m);
    if (req.method === "GET" && cl) {
      res.writeHead(200, { "content-type": "application/x-gzip" });
      return res.end(cl[1] === "basesha" ? BASE_TARBALL : HEAD_TARBALL);
    }
    if (req.method === "POST" && m === "/repos/o/r/pulls/1/reviews") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      created = JSON.parse(raw);
      return json(200, { id: 1 });
    }
    return json(404, { message: `unexpected ${req.method} ${m}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const octo = new Octokit({ auth: TOKEN, baseUrl: `http://127.0.0.1:${port}` }) as unknown as Octo;

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "guardrails-smoke-cloud-"));
  let extractedBytes = 0;
  let extractedFiles = 0;
  let disposed = false;
  const ev: PullRequestEvent = {
    installationId: 1,
    owner: "o",
    repo: "r",
    number: 1,
    headSha: "headsha",
    baseSha: "basesha",
    action: "opened",
    draft: false,
    isFork: false,
    labels: [],
    senderLogin: "dev",
    senderType: "User",
  };

  const started = Date.now();
  try {
    console.log(`model: ${process.env.GUARDRAILS_MODEL} (cap $${MAX_USD}); fake GitHub on 127.0.0.1:${port}`);
    await reviewPullRequest(ev, {
      octokit: async () => octo,
      env: { GUARDRAILS_MODE: "agent", GUARDRAILS_REVIEW_BUDGET_USD: String(MAX_USD), GUARDRAILS_REVIEW_TIMEOUT_SEC: "240" },
      createWorkspace: async (opts) => {
        const ws = await TarballWorkspace.create({ ...opts, tmpRoot });
        extractedBytes = dirBytes(tmpRoot);
        extractedFiles = (await ws.listFiles({ ref: "head" })).files.length + (await ws.listFiles({ ref: "base" })).files.length;
        const wrapped: DisposableWorkspace = Object.assign(Object.create(ws) as DisposableWorkspace, {
          dispose: async () => {
            await ws.dispose();
            disposed = true;
          },
        });
        return wrapped;
      },
    });
  } finally {
    server.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  const ms = Date.now() - started;

  console.log(`\nfake GitHub requests:\n  ${requests.join("\n  ")}`);
  console.log(`\nauth header seen on API calls: ${authOk ? "yes" : "NO"}`);
  console.log(`extracted: ${(extractedBytes / (1024 * 1024)).toFixed(4)} MB in ${extractedFiles} file(s) (base + head); workspace disposed: ${disposed}`);
  console.log(`wall time: ${(ms / 1000).toFixed(1)} s`);
  if (!created) {
    throw new Error("no review was posted");
  }
  console.log(`\nposted review body:\n${created.body}`);
  console.log(`\ninline comments (${created.comments?.length ?? 0}):`);
  for (const c of created.comments ?? []) console.log(`  - ${c.path}:${c.line}  ${c.body.split("\n")[0]}`);
  expect(authOk).toBe(true);
  expect(disposed).toBe(true);
}

describe.skipIf(!process.env.GUARDRAILS_SMOKE)("cloud smoke (real model, fake GitHub)", () => {
  it("reviews a tiny repo through the tarball workspace", async () => {
    process.exitCode = undefined;
    await main();
    expect(process.exitCode).toBeUndefined();
  }, 280_000);
});
