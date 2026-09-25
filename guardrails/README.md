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

- `--mode basic|standard|deep` review mode (see Review modes; default: from config, else `standard`). `--engine agent|single` (default `agent`: the model can read files and grep the repo; `single` is one call over the diff).
- `--model <id>` overrides `GUARDRAILS_MODEL`.
- `--budget-usd N` stops the run when the estimated spend reaches N. `--dry-run` prints the estimate and calls nothing. `--yes` accepts an estimate above US$1.
- `init` also takes `--timeout-sec N` (default 180, 0 = none): aborts the model calls with a clear error. It prints progress per stage (collect, synthesize, filter, write) on stderr, suggests at most 15 rules, and checks every rule scope against the tracked files (repairs an unambiguous truncated name, drops dead globs, lists them under "Scope warnings").
- `--json` prints machine-readable output. `--fail-on high|medium|low|none` sets the severity that fails the run (default `high`).

Exit codes: `0` no findings at or above the threshold, `1` findings at or above it, `2` usage or infrastructure error (bad arguments, missing API key, git error, incomplete review), `3` budget cut.

Rules and config are read from the **base** commit, never from the changes under review, so a change cannot weaken its own review.
Only `active` rules whose `scope` matches a changed file are sent to the model.

## Review modes

A review runs in one of three modes. The mechanical checks (`check:` rules) run in every mode.

| | `basic` | `standard` (default) | `deep` |
|---|---|---|---|
| For | small PRs, fast and permissive | normal PRs | risky or large PRs, strict and exhaustive |
| Agent steps (per pass) | 4 | 12 | 24 |
| Spend cap | US$0.05 | US$0.25 | US$0.75 |
| Minimum confidence | 0.8 | 0.6 (`strictness` 2; follows `config.strictness`) | 0.4 |
| Max model findings | 3 | 5 (follows `config.strictness`) | 12 |
| Per-rule verdicts (`ruleChecks`) | off | asked | required (an incomplete report is bounced once) |
| Passes | 1 | 1 | 2 in parallel: union, dedupe, +0.1 confidence for what both found |
| Temperature | 0 | 0 | 0 |
| Deadline | 120 s | 240 s | 240 s |

Check findings are never capped or filtered. In `deep` the two passes run at the same time under the same deadline (`GUARDRAILS_REVIEW_TIMEOUT_SEC`, default 240, below the webhook's 300 s): if time runs out, what was obtained plus the check findings is published. The PR review summary is built by code with a fixed structure: a first line with the mode and why (`**Guardrails** · mode deep (label guardrails:deep)`), the counts by origin (`3 findings: 1 from checks, 2 from the model, 1 merged duplicate`), and at most two lines of the model's notes.

One problem, one comment: in `deep`, findings of the two passes that share the file and the rule (or, without a rule, a similar title) are merged into one comment, whatever the distance between their lines; the body lists the other locations (`Also at lines 25, 31.`). Two different problems under one rule stay separate. Each finding is also moved to the added line that contains the code it quotes (backticks or quotes in the evidence, title or body, at least 8 characters); if nothing matches, the model's line is kept. Only added, commentable lines are ever chosen.

### Choosing the mode (highest priority first)

1. CLI: `guardrails review --mode basic|standard|deep`.
2. PR label `guardrails:basic|standard|deep` (case-insensitive; with several, the strictest wins).
3. A line in the PR description: `guardrails-mode: deep`.
4. `autoMode` in `.guardrails/config.json` (first matching entry), then `mode` in the same file.
5. `standard`.

Config is read from the BASE commit, like the rules. In the GitHub App, adding or removing a `guardrails:*` label re-runs the review with the new mode (any other label is ignored; no new event or permission is needed, the App already receives `pull_request`).

```json
{
  "mode": "standard",
  "prOverride": "labels",
  "autoMode": [
    { "touchesPaths": ["src/auth/**", "src/billing/**"], "mode": "deep" },
    { "onlyPaths": ["docs/**", "*.md"], "mode": "basic" },
    { "linesChangedGreaterThan": 400, "mode": "deep" },
    { "filesLessThan": 3, "linesChangedGreaterThan": 0, "mode": "basic" }
  ]
}
```

Conditions of one entry are combined with AND: `filesGreaterThan`, `filesLessThan`, `linesChangedGreaterThan` (added plus removed lines), `onlyPaths` (every changed file matches one glob), `touchesPaths` (some changed file matches). An entry needs at least one.

**`prOverride` and its risk.** With the default `"labels"`, whoever can label the PR or edit its description can pick the mode, so a PR author can relax the review of their own PR (`basic` runs fewer steps and hides low-confidence findings). Set `"prOverride": "none"` to make labels and the description powerless; the mode then comes only from the CLI flag, `autoMode` and `mode` in the base config. Mechanical checks run in every mode either way.

`--engine agent|single` selects the engine (`--mode agent|single` from before 0.7 still works).

## Configuration

`.guardrails/rules.md` holds the rules (one `## <id>` block each, with `scope`, `severity`, `type`, `source`, `status`). `type` (`logic|security|syntax|style`, default `style`) is the type of the finding when the rule is violated: the rule decides it, not the model.
`.guardrails/config.json` holds `mode`, `autoMode`, `prOverride`, `strictness`, `commentTypes`, `ignorePatterns`, `triggers` and so on.
See `PLAN-DETAILED.md` section 6.4 (in the repository root) for the format.

### Mechanical checks (`check:`)

A rule can carry a check that a program verifies without any model, on every mode. Add one line to the rule header in `rules.md`:

```md
## one-component-per-file
scope: src/components/**
severity: medium
check: max-lines: 150
exclude: **/*.test.tsx
status: active

Components stay under 150 lines.
```

| `check:` | Fires when |
|---|---|
| `max-lines: N` | a changed file in scope has more than N lines in the head |
| `colocated-test` | a new or changed source file in scope has no `name.test.*` / `name.spec.*` next to it (tests, `.d.ts` and files without logic, such as types, re-exports and plain constants, are ignored) |
| `forbid-import: <pattern>` | an ADDED line imports/requires a specifier matching the pattern (glob if it has `* ? { }`, otherwise a substring) |
| `forbid-pattern: <regex>` | an ADDED line matches the regex (max 200 characters, rejected if unsafe; `/re/i` flags `i` and `u` allowed). `forbid-pattern(comments|code|strings): <regex>` restricts it to that zone of TS/JS/TSX/JSX files |

`exclude:` is a comma-separated list of globs removed from the rule scope. Check findings have confidence 1, the rule's severity and type, and the exact `file:line`; they are never filtered or capped. If the model part of a review fails or times out, the check findings are still published.

**Coverage: exhaustive or partial.** A check either fully decides its rule or only catches a subset of violations, and the model is briefed accordingly:

| Coverage | Kinds by default | What the model is told |
|---|---|---|
| `exhaustive` | `max-lines`, `colocated-test` | The rule is verified mechanically: do not check or report it again. It is left out of the per-rule verdict pass. |
| `partial` | `forbid-import`, `forbid-pattern` | The rule stays in the prompt with the locations the check already reported (do not repeat them), and the model must still look for violations the check cannot see (for example unaccented Spanish text next to an accent regex). It stays in the per-rule verdict pass. |

A model finding that repeats a check finding (same file and rule; for a partial rule also within 3 lines) is dropped as a duplicate; a model finding elsewhere is kept. Override the default per rule with `check-coverage: exhaustive | partial` in the rule header, for example to declare a `forbid-pattern` exhaustive when it really decides the rule (this saves model spend on repos with many pattern rules):

```md
## no-console
check: forbid-pattern(code): console\.log
check-coverage: exhaustive
```
Limits of `only`: regex literals are not recognised by the lexer, JSX text between tags counts as code, other file types are skipped. Without a workspace (the cloud single-mode fallback) `max-lines`, `colocated-test` and `only` are skipped and the model handles those rules.
`guardrails init` proposes a `check:` when a rule allows it and drops an invalid one with a warning.

## Environment variables

Loaded from the process environment or from `guardrails/.env.local` (never committed). See `.env.example`.

| Variable | Purpose |
|---|---|
| `GUARDRAILS_MODEL` | Model spec: `zai:<id>`, `deepseek:<id>` or an AI Gateway id (default `anthropic/claude-sonnet-5`). |
| `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY` | Credential for the chosen model provider. |
| `GUARDRAILS_THINKING=1` | Z.ai only: keep the model's default reasoning. Without it Guardrails sends `thinking: disabled` (models that allow it) or `reasoning_effort: low` (GLM-5.3 family, which cannot disable reasoning). |
| `GUARDRAILS_TEMPERATURE` | Sampling temperature for every review/init call (default `0`; Z.ai accepts 0 to 1). Overrides the review mode's own value. |
| `GUARDRAILS_SEED` | Integer seed. By default a fixed seed is sent only to providers that document one (OpenAI ids through the Gateway); Z.ai does not, so none is sent unless you set this. |
| `GUARDRAILS_LLM_CACHE=1` | Dev/eval only: replay identical model calls from disk. |
| `GUARDRAILS_SKIP=1` | Skips the pre-push hook for one push. |
| `GUARDRAILS_REVIEW_BUDGET_USD`, `GUARDRAILS_REVIEW_TIMEOUT_SEC` | Webhook only: replace the mode's spend cap; deadline of one review (default 240 s). |
| `GUARDRAILS_SHOW_STATS=1` | Webhook only: adds a footer to the PR summary (`Cost ~US$0.02 · 38 s · 2 passes`). Off by default. The `review.analyzed` log always has mode, passes, tokens, cost and duration. |
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
