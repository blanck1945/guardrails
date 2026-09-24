# Deploy on Vercel

This deploys the GitHub App webhook (`/api/webhooks/github`) and the health probe (`/api/health`) as a Next.js project on Vercel.
The repository root is `codereview-ai/`; the Next.js project lives in `guardrails/`, so Vercel must use `guardrails` as the **Root Directory**.

Nothing in the repository deploys automatically: you run every command below.

## Prerequisites

- The GitHub App exists and is installed on one repository: `docs/github-app-setup.md` (you need `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`).
- A model credential, for example `ZAI_API_KEY` with `GUARDRAILS_MODEL=zai:glm-5.3`.
- Vercel CLI: `pnpm add -g vercel` (or `npx vercel`).

## 1. Log in and link

```sh
cd guardrails
vercel login
vercel link          # create a new project; accept the detected Next.js framework
```

If you link from the Vercel dashboard instead (import the GitHub repository), set **Settings, General, Root Directory** to `guardrails`.

`vercel.json` already sets the function duration for the webhook (`maxDuration: 300`) and the region (`gru1`, Sao Paulo).
Change `regions` to the one closest to you and to your model provider. It contains no secrets.

## 2. Add the environment variables

Add each variable for the `production` environment (and `preview` if you want preview deployments to answer webhooks). Mark secrets as sensitive when prompted.

```sh
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production   # one line, newlines as \n
vercel env add GITHUB_WEBHOOK_SECRET production
vercel env add GUARDRAILS_MODEL production          # for example zai:glm-5.3
vercel env add ZAI_API_KEY production               # or DEEPSEEK_API_KEY / AI_GATEWAY_API_KEY
```

`vercel env add` reads the value from the prompt (or from stdin: `printf %s "$VALUE" | vercel env add NAME production`).
Do not set `GUARDRAILS_LLM_CACHE` in production. See `.env.example` for the full list with comments.

Optional review settings (all have defaults, none is required):

| Variable | Default | Meaning |
|---|---|---|
| `GUARDRAILS_MODE` | `agent` | `agent` downloads the repository as a tarball and lets the agent search and read it; `single` makes one model call over the diff and a few files (the previous behaviour). |
| `GUARDRAILS_REVIEW_BUDGET_USD` | `0.25` | Spend cap per review. When it is reached the review stops and the PR gets a short notice; there is no fallback. |
| `GUARDRAILS_REVIEW_TIMEOUT_SEC` | `240` | Deadline for the whole review (tarball download plus model loop). The function limit is 300 s (`vercel.json`), so keep this below it. |

Check what is set (values are not shown): `vercel env ls`.

## 3. First deploy

```sh
vercel deploy --prod
```

The command prints the production URL. Environment variables are read at build/deploy time, so redeploy after changing any of them.
This is a manual step: the repository has no CI that deploys.

## 4. Point the GitHub App at the deployment

1. GitHub, Settings, Developer settings, GitHub Apps, your App, **General**.
2. **Webhook URL**: `https://<your-domain>/api/webhooks/github`. Make sure **Active** is checked and the **Webhook secret** equals `GITHUB_WEBHOOK_SECRET`.
3. Save.

## 5. Logs

- Live: `vercel logs <deployment-url>` (streams new log lines), or the **Logs** tab of the project in the dashboard.
- The handler writes one JSON line per event with these names: `webhook.rejected`, `webhook.ignored` (with a `reason`), `review.started`, `review.finished` (with `ms`), `review.analyzed` (mode, cost, number of findings), `review.fallback` (with a `reason`), `review.skipped` (with a `reason`), `review.failed`. Logs never contain code, diffs, comment text or secrets.
- GitHub side: App settings, **Advanced**, **Recent Deliveries** shows the response code of each delivery and lets you redeliver.

## 6. Verification checklist

1. Health: `curl -i https://<your-domain>/api/health` returns `200` and `{"status":"ok"}`.
2. Signature: in Recent Deliveries, redeliver a `ping`/`pull_request` delivery: a `202` means the secret matches; `401` means it does not.
3. Test PR: in the repository where the App is installed, open a small non-draft PR from a branch (not from a bot, no `skip-guardrails` label).
4. Logs show `review.started` then `review.finished`.
5. The PR gets a review from the App (inline comments on changed lines, or a summary). Rule citations appear only if `.guardrails/rules.md` exists on the base branch with `status: active` rules.
6. Push another commit to the PR: a new review is posted for the new head commit.

If step 5 fails, read the logs for `review.failed`; the most common causes are a wrong `GITHUB_APP_PRIVATE_KEY` format or a missing model key.

## Known limits of this MVP

- **Agent mode over a tarball (default)**: the webhook downloads the base and head commits as tarballs through the GitHub API (with the installation token), extracts them into the function's temporary disk (`os.tmpdir()`, a random directory with mode 0700 per review) and runs the agent there. The agent only reads files (`read_file`, `grep`, `list_files`, `find_references`); nothing from the repository is executed, and there is no `git`, sandbox or clone. The directories are deleted in a `finally`, even on error or timeout.
- **Extraction limits**: `.git`, `node_modules` and default-ignored paths (lockfiles, `dist/`, `build/`, `vendor/`, minified files, snapshots) are not extracted; files above 1 MB are omitted; symlinks and hardlinks are dropped; entries with `..` or absolute paths are rejected. At most 150 MB and 20,000 files are extracted per tree, and the download times out after 60 s. Beyond those limits the repository counts as too large.
- **Automatic fallback to single mode**: if the tarball cannot be obtained (download error, repository too large, download too slow) the review falls back to `single` mode and logs `review.fallback` with a short `reason` (`repo-too-large`, `download-timeout`, `download-failed`, `workspace-failed`). If the agent fails for budget, the PR gets the generic spend-limit notice instead (no fallback); if the review deadline passes, it gets the generic time-out notice.
- **Memory and disk**: the tarball response is held in memory while it is extracted (two of them, base and head, at the same time), and both trees stay on the function's temporary disk until the review ends. Very large repositories can hit the function memory limit before the size caps apply; if that happens, set `GUARDRAILS_MODE=single`.
- **PRs from forks** are read from `refs/pull/<number>/head` of the base repository.
- **Single mode** (`GUARDRAILS_MODE=single`, or the fallback): one model call over the diff; it reads up to 15 changed files (and a few docs) with the contents API, so there is no repository-wide search.
- **No database**: persistence and the sandbox arrive in a later phase (backlog B18 to B22). Nothing is stored between reviews.
- **Dedupe is in memory**: repeated deliveries of the same `x-github-delivery` are dropped only if they reach the same warm instance within one hour. A cold start or another instance can review twice. The durable version needs the database (backlog B19).
- **No supersede or debounce**: several quick pushes to one PR produce several reviews, possibly on outdated commits.
- **Size limit**: a diff above 200,000 characters is truncated before it reaches the model.
- **Time limit**: the function is capped at 300 seconds (`vercel.json`); the review has its own deadline (`GUARDRAILS_REVIEW_TIMEOUT_SEC`, 240 s by default) and the PR receives a short notice when it is reached.
- Only `pull_request` events are handled: no `@guardrails` commands and no feedback capture (reactions) yet.
