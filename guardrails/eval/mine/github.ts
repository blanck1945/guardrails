import { execFileSync } from "node:child_process";
import type { Octokit as OctokitType } from "octokit";

/**
 * Token from GITHUB_TOKEN or `gh auth token`. It is only handed to Octokit: never logged,
 * never written to disk (the cache stores response bodies, not headers).
 */
export function resolveToken(): string {
  const env = process.env.GITHUB_TOKEN?.trim();
  if (env) return env;
  try {
    const t = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (t) return t;
  } catch {
    // fall through
  }
  throw new Error("No GitHub token: set GITHUB_TOKEN or run `gh auth login`.");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_WAIT_MS = 15 * 60_000;
const LOW_WATERMARK = 15;

/**
 * Octokit with rate-limit awareness: it tracks `x-ratelimit-remaining` and sleeps until
 * reset when the budget is nearly gone (giving up if that would take >15 min), and the
 * bundled throttling plugin retries primary/secondary rate-limit responses.
 */
export async function createOctokit(token = resolveToken()): Promise<OctokitType> {
  // Dynamic import: `octokit` is ESM-only and this script runs through tsx in CJS mode.
  const { Octokit } = await import("octokit");
  let remaining = Infinity;
  let resetAt = 0;
  const octo = new Octokit({
    auth: token,
    userAgent: "guardrails-eval-mine",
    throttle: {
      onRateLimit: (retryAfter: number, _o: unknown, _oc: unknown, retryCount: number) => {
        console.error(`rate limited; retrying in ${retryAfter}s (attempt ${retryCount + 1})`);
        return retryCount < 2 && retryAfter * 1000 <= MAX_WAIT_MS;
      },
      onSecondaryRateLimit: (retryAfter: number, _o: unknown, _oc: unknown, retryCount: number) => {
        console.error(`secondary rate limit; retrying in ${retryAfter}s (attempt ${retryCount + 1})`);
        return retryCount < 2 && retryAfter * 1000 <= MAX_WAIT_MS;
      },
    },
  });

  octo.hook.before("request", async () => {
    if (remaining > LOW_WATERMARK) return;
    const wait = resetAt * 1000 - Date.now() + 2000;
    if (wait > MAX_WAIT_MS) throw new Error(`GitHub rate limit exhausted; resets in ${Math.round(wait / 60000)} min`);
    if (wait > 0) {
      console.error(`rate limit low (${remaining} left); sleeping ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
    remaining = Infinity;
  });
  octo.hook.after("request", (res) => {
    const r = Number(res.headers["x-ratelimit-remaining"]);
    const reset = Number(res.headers["x-ratelimit-reset"]);
    if (Number.isFinite(r)) remaining = r;
    if (Number.isFinite(reset)) resetAt = reset;
  });
  return octo;
}

export type Api = OctokitType;
