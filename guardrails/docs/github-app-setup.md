# GitHub App setup

This guide creates the GitHub App that lets Guardrails comment on pull requests. No prior experience with GitHub Apps is needed.
Nothing here is done by the code: you create the App on github.com and copy three values into your environment.

## What the App gets

Minimum permissions (repository level):

| Permission | Level | Why |
|---|---|---|
| Metadata | Read | Mandatory for every App. |
| Contents | Read | Reads `.guardrails/config.json`, `.guardrails/rules.md` and the changed files. |
| Pull requests | Write | Reads the PR and its files, and publishes the review. |

Subscribed event: `pull_request`. Nothing else (no Checks, Issues, Actions, Workflows, Administration, Secrets or Contents:write).
This list is kept in `github-app/manifest.json` and a test checks that it matches what the code uses.

## Before you start

You need the public URL where the webhook will live: `https://<your-domain>/api/webhooks/github`.
If you have not deployed yet, use a tunnel first (see "Try it locally with a tunnel" below) and change the URL later; it is editable in the App settings.

## Step 1: create the App

### Option A: by hand (simplest the first time)

1. GitHub, click your avatar, **Settings**, **Developer settings**, **GitHub Apps**, **New GitHub App**. (For an organization: the organization's Settings, Developer settings.)
2. **GitHub App name**: any globally unique name, for example `guardrails-<your-user>`.
3. **Homepage URL**: any URL, for example the repository URL.
4. **Webhook**: check **Active**. **Webhook URL**: `https://<your-domain>/api/webhooks/github`. **Webhook secret**: a long random string. Generate one with `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) and keep it: you will paste it into `GITHUB_WEBHOOK_SECRET`.
5. **Repository permissions**: set **Contents: Read-only**, **Pull requests: Read and write**. **Metadata: Read-only** is selected automatically. Leave everything else as "No access".
6. **Subscribe to events**: check **Pull request** only.
7. **Where can this GitHub App be installed?**: **Only on this account**.
8. Click **Create GitHub App**.

### Option B: from the manifest

`github-app/manifest.json` already has the permissions and events. Replace the two `REPLACE-WITH-YOUR-DOMAIN` placeholders:

- `hook_attributes.url`: `https://<your-domain>/api/webhooks/github` (the webhook URL).
- `redirect_url`: any page you control, for example `https://<your-domain>/`. GitHub sends you there after creation, with `?code=...` in the URL.

Also change `name` to a globally unique name.

1. Open `github-app/create-from-manifest.html` in a browser, paste the edited manifest and click the button. GitHub shows a confirmation page; click **Create GitHub App**.
2. You land on `redirect_url?code=<CODE>`. Copy `<CODE>` from the address bar (it is valid for one hour).
3. Exchange it for the credentials, once (needs the `gh` CLI, logged in as the same user):

   ```sh
   gh api -X POST /app-manifests/<CODE>/conversions
   ```

   The JSON response contains `id` (the App ID), `pem` (the private key) and `webhook_secret`. Save them; GitHub will not show the secret again.
   `pem` is one JSON string with `\n` escapes, which is exactly the one-line format `GITHUB_APP_PRIVATE_KEY` wants.

## Step 2: collect the three values

| Value | Where it comes from |
|---|---|
| `GITHUB_APP_ID` | The App's settings page (Developer settings, GitHub Apps, **Edit** on your App), section **About**, field **App ID** (a number). |
| `GITHUB_APP_PRIVATE_KEY` | On the same page, scroll to **Private keys** and click **Generate a private key**. A `.pem` file downloads. Keep it private; you can generate a new one and delete the old one at any time. |
| `GITHUB_WEBHOOK_SECRET` | The string you chose in step 1 (Option A), or `webhook_secret` from the conversion response (Option B). To change it later: App settings, **Webhook**, **Webhook secret**. |

### Turn the .pem into one line

The environment variable must be a single line with the newlines written as the two characters `\n`:

```sh
awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' guardrails-app.private-key.pem
```

Copy the output (it starts with `-----BEGIN RSA PRIVATE KEY-----\n`) and use it as the value. Do not add the `.pem` file to git.

## Step 3: install the App on one repository

1. App settings, **Install App** (left column), **Install** next to your account.
2. Choose **Only select repositories** and pick the one repository you want to try (for example `blanck1945/claudeStarter`). Do not choose "All repositories".
3. Confirm the permissions and click **Install**.

To add or remove repositories later: Settings, Applications, Installed GitHub Apps, **Configure**.

## Step 4: put the values where the code reads them

### Locally: `guardrails/.env.local`

```sh
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
GITHUB_WEBHOOK_SECRET=the-secret-you-chose
# plus the model credential, for example:
GUARDRAILS_MODEL=zai:glm-5.3
ZAI_API_KEY=...
```

`.env.local` is git-ignored. See `.env.example` for every variable.

### On Vercel

```sh
vercel env add GITHUB_APP_ID production
vercel env add GITHUB_APP_PRIVATE_KEY production   # paste the one-line value; mark it sensitive
vercel env add GITHUB_WEBHOOK_SECRET production    # mark it sensitive
```

Full walkthrough in `docs/deploy-vercel.md`.

## Try it locally with a tunnel (before deploying)

1. Start the app: `pnpm dev` (listens on `http://localhost:3000`).
2. Open a tunnel to port 3000. Either:
   - ngrok: `ngrok http 3000`, or
   - cloudflared: `cloudflared tunnel --url http://localhost:3000`

   Copy the public `https://...` URL it prints.
3. In the App settings, set **Webhook URL** to `https://<tunnel-host>/api/webhooks/github`.
4. Check the health endpoint through the tunnel: `curl https://<tunnel-host>/api/health` returns `{"status":"ok"}`.
5. Open a pull request in the repository where the App is installed. Watch the `pnpm dev` terminal: you should see JSON log lines (`review.started`, `review.finished`, or `webhook.ignored` with a reason) and, a minute later, the review on the PR.
6. To debug delivery problems: App settings, **Advanced**, **Recent Deliveries** shows every request GitHub sent, the response code, and lets you **Redeliver**. The handler answers `401` for a wrong webhook secret and `202` for everything it accepts or deliberately ignores.

Remember to point the Webhook URL at your real domain once you deploy, and stop the tunnel.

## What the handler ignores on purpose

Draft PRs (unless `triggers.drafts` is true), PRs from forks when `triggers.forks` is false, PRs carrying a label in `triggers.skipLabels` (default `skip-guardrails`), events triggered by bots or by the App itself, repeated deliveries of the same `x-github-delivery`, and every event other than `pull_request`.
`triggers` is read from `.guardrails/config.json` on the PR's **base** branch.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Delivery shows `401` | `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret. |
| Delivery shows `202` but no comment | Ignored by design (see above), or the review failed: check the logs for `review.failed`. |
| `secretOrPrivateKey must be an asymmetric key` in logs | `GITHUB_APP_PRIVATE_KEY` is not a valid one-line PEM (missing `\n` escapes, or extra quotes on Vercel). |
| Comment says the change is too large | The diff exceeds 200,000 characters; split the PR. |
