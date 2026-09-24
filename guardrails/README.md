# Guardrails

Guardrails reviews code changes with an LLM and enforces your team's written rules (`CLAUDE.md`, `CONTRIBUTING.md`, lint conventions).
It runs three ways: locally from the terminal, as a git `pre-push` hook, and as a GitHub App that comments on pull requests.

Requirements: Node 22+, pnpm, git. Install dependencies with `pnpm install`.

## Commands

All commands run from this directory as `pnpm guardrails <command>`.

| Command | What it does |
|---|---|
| `init [--path <repo>] [--write]` | Reads the repo's docs and suggests rules. With `--write` they are appended to `.guardrails/rules.md` as `status: suggested`; change them to `active` to enforce them. |
| `review [--path <repo>] [--base <ref>] [--head <ref>]` | Reviews the diff between two revisions. Defaults: `--path .`, `--head HEAD`, `--base` = merge-base of HEAD with `origin/HEAD`, `main` or `master`. |
| `hook install [--path <repo>]` | Installs a `pre-push` hook in the target repo. |
| `hook uninstall [--path <repo>]` | Removes it (and restores a hook that existed before). |
| `smoke` | One minimal check against the real model (capped at US$0.05). |

`review` options:

- `--mode agent|single` (default `agent`: the model can read files and grep the repo; `single` is one call over the diff).
- `--model <id>` overrides `GUARDRAILS_MODEL`.
- `--budget-usd N` stops the run when the estimated spend reaches N. `--dry-run` prints the estimate and calls nothing. `--yes` accepts an estimate above US$1.
- `init` also takes `--timeout-sec N` (default 180, 0 = none): aborts the model calls with a clear error. It prints progress per stage (collect, synthesize, filter, write) on stderr, suggests at most 15 rules, and checks every rule scope against the tracked files (repairs an unambiguous truncated name, drops dead globs, lists them under "Scope warnings").
- `--json` prints machine-readable output. `--fail-on high|medium|low|none` sets the severity that fails the run (default `high`).

Exit codes: `0` no findings at or above the threshold, `1` findings at or above it, `2` usage or infrastructure error (bad arguments, missing API key, git error, incomplete review), `3` budget cut.

Rules and config are read from the **base** commit, never from the changes under review, so a change cannot weaken its own review.
Only `active` rules whose `scope` matches a changed file are sent to the model.

## Configuration

`.guardrails/rules.md` holds the rules (one `## <id>` block each, with `scope`, `severity`, `source`, `status`).
`.guardrails/config.json` holds `strictness`, `commentTypes`, `ignorePatterns`, `triggers` and so on.
See `PLAN-DETAILED.md` section 6.4 (in the repository root) for the format.

## Environment variables

Loaded from the process environment or from `guardrails/.env.local` (never committed). See `.env.example`.

| Variable | Purpose |
|---|---|
| `GUARDRAILS_MODEL` | Model spec: `zai:<id>`, `deepseek:<id>` or an AI Gateway id (default `anthropic/claude-sonnet-5`). |
| `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY` | Credential for the chosen model provider. |
| `GUARDRAILS_THINKING=1` | Z.ai only: keep the model's default reasoning. Without it Guardrails sends `thinking: disabled` (models that allow it) or `reasoning_effort: low` (GLM-5.3 family, which cannot disable reasoning). |
| `GUARDRAILS_LLM_CACHE=1` | Dev/eval only: replay identical model calls from disk. |
| `GUARDRAILS_SKIP=1` | Skips the pre-push hook for one push. |
| `GUARDRAILS_BUDGET_USD` | Per-review budget used by the hook (default `0.50`). |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | GitHub App only; see `docs/github-app-setup.md`. |

## Pre-push hook

```sh
pnpm guardrails hook install --path /path/to/your/repo
```

On every `git push` the hook runs `guardrails review` on exactly the commits being pushed (git passes the local and remote SHAs to the hook).

- It blocks the push **only** when the review finds issues at or above the threshold (`high`).
- If Guardrails cannot run (no API key, network error, budget cut, crash) it prints a warning and lets the push through.
- `GUARDRAILS_SKIP=1 git push` skips it.
- An existing `pre-push` hook is not overwritten: it is renamed to `pre-push.pre-guardrails` and keeps running first. `hook uninstall` restores it.
- The hook needs the tool checkout to stay where it was when you installed it (the path is written into the hook).

## GitHub App

- Setup: `docs/github-app-setup.md`
- Deploy: `docs/deploy-vercel.md`

## Development

`pnpm check` runs the type check and the tests (no test calls a real model).
