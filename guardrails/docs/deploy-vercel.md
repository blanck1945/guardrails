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
- The handler writes one JSON line per event with these names: `webhook.rejected`, `webhook.ignored` (with a `reason`), `review.started`, `review.finished` (with `ms`), `review.skipped` (with a `reason`), `review.failed`. Logs never contain code, diffs, comment text or secrets.
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

- **Single-call mode**: the webhook runs one model call over the diff (`mode: single`); the multi-step agent that greps and reads the repository is only available in the local CLI for now.
- **Reads through the GitHub API**: it fetches the diff and up to 15 changed files (and a few docs) with the contents API; there is no clone, so no repository-wide search.
- **No sandbox and no database**: execution in an isolated sandbox and persistence arrive in the next phase (backlog S1, B18 to B22). Nothing is stored between reviews.
- **Dedupe is in memory**: repeated deliveries of the same `x-github-delivery` are dropped only if they reach the same warm instance within one hour. A cold start or another instance can review twice. The durable version needs the database (backlog B19).
- **No supersede or debounce**: several quick pushes to one PR produce several reviews, possibly on outdated commits.
- **Size limit**: a diff above 200,000 characters is not reviewed; the PR receives a short notice.
- **Time limit**: the function is capped at 300 seconds (`vercel.json`); a slower model call is cut and logged as `review.failed`.
- Only `pull_request` events are handled: no `@guardrails` commands and no feedback capture (reactions) yet.
