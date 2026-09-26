# Plan: Roadmap v0.7.4 → v0.11.0 (coverage report, review records and consolidated report, GitLab, D-019/D-020)

**Created:** 2026-09-26
**Original request:** PLAN-DEEP / PLAN-ONLY. The user asked: (1) can I see the coverage level of a review, and does it make sense; (2) can I see a final report, also when the review came from GitLab; plus the pending D-019/D-020 work (init on install, incremental rule refresh, learning from feedback, efficiency) and the small v0.7.4 items. Decide concretely, sequence the work, estimate subagent tokens and Z.ai spend.
**Handoff:** `.cursor/handoff/2026-09-26-roadmap-v0-8-plan.md`
**Ground truth read:** `2026-09-24-guardrails-context.md`, `2026-09-24-next-steps-plan.md`, `DECISIONS.md` (D-001..D-026), `docs/RESULTADOS.md` (M1–M9), `docs/sessions/2026-09-23_26-guardrails.md`, `guardrails/CHANGELOG.md` (v0.1.0..v0.7.3), `guardrails/CLAUDE.md`, `PLAN-DETAILED.md` §1, §2, §5, §6.4, §8, §9, §10, and the code listed under "Current state". Git (read-only): local `master` = `cf1eace` (docs only after `68c5ccb`), `origin/master` = `68c5ccb`, clean tree.

## Objective

Give the user two things they asked for, in the cheapest order that keeps the product honest:
1. A **coverage report** in every review: what was actually examined, with mechanical guarantees and model claims kept apart.
2. A **final report per review** (the PR summary plus a machine-readable record) and a **consolidated report** per repository and period, computed the same way for GitHub and, later, GitLab.
Then resolve D-019/D-020 with concrete choices, and sequence five versions with per-task acceptance, agent type, subagent tokens and Z.ai caps.

**Do not touch (in this plan and in every task below unless stated):** GitHub App permissions and events (D-008; no `checks`, `issues` or `contents: write`), the answer key file, causas-viewer `main`, Vercel settings, key rotation. No DB provisioning without the user. Never bypass a permission denial; if a classifier or the user blocks an action, only the user decides.

## Decisions made

- **Relied on:** D-002 (core independent of provider), D-003 (Vercel), D-004 (tarball workspace), D-005 (rules.md with states; never auto-activate), D-007 (rules/config from base), D-008 (minimal permissions), D-010/D-011 (Z.ai for testing, spend control, costs are estimates), D-013, D-015/D-022 (check coverage exhaustive/partial), D-016 (modes), D-023 (release gate: real-model verification before push), D-025 (one problem, one comment), D-026 (anchors in evidence ranges), D-018/D-024 (Baking mandatory).
- **New decisions to append:** D-027 to D-039, listed with title, status and one-line why in section "Proposed DECISIONS entries" at the end. `DECISIONS.md` is written in Spanish: the orchestrator translates when appending.

## Minimal context

- App: `C:\Users\elabu\Desktop\side-apps\codereview-ai\guardrails` (Next.js 16, TS, pnpm, vitest, AI SDK 7, octokit 5). Conventions: `guardrails/CLAUDE.md` (English, `pnpm check` + `pnpm build` green, no test calls a real model, every version bumps `package.json` and adds a CHANGELOG entry with did / observed / next).
- Verification clone for real runs: `C:\Users\elabu\AppData\Local\Temp\causas-viewer-v071` (branch `base71` = causas `main` + 4 `check:` lines; branches `v73/case-reminders`, `v73/clients-page`, `v73/csv-export`). Older clone `...\causas-viewer-b45` has all 6 PR branches (`b45/*`, base `base45`). Running the CLI there needs the user's explicit authorization, as before (D-023 note).
- Known environment gotchas that change designs here: `tsx` cannot load `octokit` (ESM only) → any new CLI that talks to GitHub/GitLab must use `fetch`, not Octokit. The Bash tool halves backslashes. `pnpm guardrails ... --json` prints a banner before the JSON.
- External APIs used by this plan: GitHub REST (pulls, reviews, review comments, compare), GitHub GraphQL (`reviewThreads`, `reactionGroups`), GitLab REST v4 (MR events, `merge_requests/:iid/diffs`, `discussions`, `notes`, `repository/files/:path/raw`, `repository/archive.tar.gz`). Postgres (Neon via Vercel Marketplace) + Drizzle only in the deferred persistence step.

## Current state (verified in code, 2026-09-26)

| Area | What exists | Gap relevant to this plan |
|---|---|---|
| Review output | `ReviewOutput` (`src/core/review.ts:56-86`): findings, dropped (with reason), `checks {ran, skipped, findings}`, `ruleChecks`, `modelIncomplete`, `incomplete`, `passes`, `passesFailed`, `merged`, `omitted`, usage, costUsd | `ruleChecks` are returned and **never shown**; `checks.exhaustive`/`partial` ids are computed by `runChecks` (`checks/run.ts:95-230`) but not exposed; `forcedWrapUp` exists in `AgentRunResult` (`agent/loop.ts:50`) but is dropped; no record of which files the agent opened |
| Summary | `buildSummary` (`src/core/summary.ts:44`): header (mode, source), counts by origin, status lines, 2 note lines; `statsFooter` behind `GUARDRAILS_SHOW_STATS=1` | No coverage; cost hidden by default |
| Cloud file selection | `review-pr.ts:126-130` keeps files with a `patch`, not `removed`, not ignored | Removed, ignored and patch-less (binary or too large) files disappear silently |
| **Cloud diff budget** | `review-pr.ts:152` `fullDiff.slice(0, MAX_DIFF_CHARS)` (200k chars) | **Silent mid-file truncation**: files past the cut are neither seen by the model nor by the checks (`runChecks` parses `input.diff`), and nothing says so. `DiffTooLargeError` is declared and classified but never thrown in the cloud. The CLI refuses instead (`cli/review.ts:267`) |
| Single-mode fallback | `review-pr.ts:166-183`: tarball failure → `single`, first 15 files as context; checks needing the workspace are skipped (`CheckSkip needs-workspace`) | Only visible in logs (`review.fallback`), not in the PR |
| Logs | `review.analyzed` (`review-pr.ts:211`): mode, passes, tokens, steps, ms, costUsd, findings, merged, incomplete. `log.ts` drops content fields and objects | Vercel runtime log retention is short; not a store |
| Persistence | None. Dedupe in memory (`webhook.ts:37`) | No per-review record, no incremental state, no feedback |
| Provider coupling | `src/cloud/*` is GitHub-only by design | **D-002 leak:** `TarballWorkspace.create` (core) takes a `TarballOctokit` and calls `GET /repos/{owner}/{repo}/tarball/{+ref}` (`workspace/tarball.ts:67-73, 223-245`) |
| "Also at" | `mergeAcrossPasses` (`findings/dedupe.ts:147-150`) adds the other pass's line to `also` with no validation | v0.7.3 run 2 listed line 10 (not the heading) |
| LocalWorkspace | `readFile` head reads the working tree (`workspace/local.ts:113-118`); `grep`/`findReferencesByName` run `git grep` on the working tree | CLI must check out the head branch; wrong results otherwise |
| Dry-run estimate | `spend.ts:17` fixed profile 273k input tokens; `cli/review.ts:283` | Overstates ~10× on small PRs (CHANGELOG v0.7.1) |
| init | `runInit` works over any `Workspace` (`init/run.ts`, `init/collect.ts` use `listFiles`/`readFile`) → usable in the cloud over a `TarballWorkspace` | Not wired to the cloud |
| App | permissions contents:read, pull_requests:write, metadata:read; event `pull_request`; actions opened/synchronize/reopened/ready_for_review + labeled/unlabeled for `guardrails:*` (`app-permissions.ts`) | `closed` is received and ignored → usable later for a feedback sweep without a new event |

## Decisions made (summary table)

| # | Decision | Chosen option | Why (one line) | Rejected alternatives |
|---|---|---|---|---|
| 1 | Coverage report | Computed by a pure core function; one visible line in the summary + a collapsed `<details>` block; config `coverage: "details" \| "line" \| "off"` (default `details`, read from base) | Answers the user's question without new infra and keeps the summary short | A separate comment (noise, one more API call); Check Run (needs `checks: write`, D-008) |
| 2 | Diff budget | Pack **whole files** into the model's diff budget; files that do not fit are declared `over-budget`; **checks run over the full diff** | Today's silent mid-file cut makes any coverage claim false | Keep slicing (dishonest); refuse large PRs as the CLI does (loses the check findings, which are free) |
| 3 | Guarantee vs claim labels | Two words only: **check** (exact result of code for what the check tests) and **model** (the model's claim) | The user must not read a model "ok" as a guarantee | Percent "coverage score" (implies precision we do not have) |
| 4 | First store | **Signed hidden marker** (`ReviewRecord v1`) at the end of the review summary; the provider (GitHub, later GitLab) is the store | Zero infra, provider-neutral, and it is also the incremental state (Q4 default) | Neon first (infra before value); JSON from Vercel logs (retention too short, drains paid); Vercel Blob (listing/aggregation clumsy, privacy of URLs); lock file in repo (needs `contents: write`, per-PR state does not belong in the repo) |
| 5 | What is stored | Metadata only: ids, SHAs, mode, model, tokens, cost, coverage counters, and per finding: fingerprint, rule, origin, type, severity, confidence, path, line, inline flag. **Never** code, diff, titles, bodies, suggestions, evidence notes, PR title/description or people's logins | Privacy per PLAN §8 and the user's "never code"; content already lives in the provider | Storing titles/bodies for 180 days (PLAN §2): titles quote code |
| 6 | Consolidated report, first slice | `guardrails report` CLI (fetch-based) → Markdown + CSV, computed from records plus **live** feedback signals read from the provider (reactions, resolved/outdated threads). Audience: repo owner | Delivers value with no DB, no hosting, no new permission; feedback stays in GitHub so nothing is lost by waiting for a DB | Hosted dashboard with login (B28, needs DB + auth); PR comment on demand (needs `issue_comment` event); Check Run (permission) |
| 7 | Postgres | **Deferred** behind explicit triggers (see §B.5); schema = subset of PLAN §2 with the record fields | Nothing in v0.8–v0.11 needs it; the prepaid Z.ai balance is today's hard spend stop | Neon now (cost in subagent tokens with no user-visible gain yet) |
| 8 | GitLab position | v0.11.0: after the record layer (v0.9) and efficiency (v0.10), **before** Postgres | Records/report are already provider-neutral; single-project GitLab needs no DB | After Postgres (delays the user's request for no technical reason) |
| 9 | Incremental state (D-019/D-020) | Latest **bot-authored, signed** marker on the PR → `lastReviewedSha`; DB becomes primary later, marker stays as fallback | No permission, no infra, survives cold starts | Lock file (write permission); DB now (deferred) |
| 10 | `init` on install | **Init on the first review of a repo without rules**: proposed rules in a collapsed section of that review's summary; no new permission; no action on the `installation` event itself | There is no PR or issue to comment on at install time without `issues: write` | Issue (needs `issues: write`); PR with rules.md (needs `contents: write`) |
| 11 | Rule refresh / obsolete rules | Source hashes in a comment line of the rules.md preamble; delta synthesis proposed only on PRs that change a source; obsolete rules are **flagged, never removed** | Reads from base (D-007), no write permission, no model call when nothing changed | Lock file written by the App (permission); auto-disable (breaks D-005) |
| 12 | Learning from feedback | Rule-level suggestions only (narrow/disable proposals, new-rule proposals), thresholds in §D.4; needs the DB; embedding filter stays PLAN F2c | Cheap, explainable, never silently hides findings | Embedding filter now (needs ≥4 weeks of data and pgvector) |
| 13 | Efficiency order | skip trivial diffs → `basic` on glm-5.3-flash → cost visible by default → incremental re-review → prompt-prefix reorder → daily cap (with DB) | Order by savings per subagent token spent and by risk | Daily cap first (needs shared state, protects little with one repo) |

---

## §A. Coverage report (v0.8.0)

### A.1 Metric definitions

**File status.** Every file in the PR's changed-file list gets exactly one status, first match wins:

| Status | Definition | Source |
|---|---|---|
| `removed` | deleted by the PR | provider file status |
| `ignored` | matches `DEFAULT_IGNORES` or `config.ignorePatterns` (reason `default-ignore` / `config-ignore`) | `paths.ts isIgnored` |
| `no-diff` | the provider sent no textual patch (binary, or GitHub omitted the patch because it is too large) | `patch` missing |
| `over-budget` | has a patch but did not fit whole in the model's diff budget (200k chars); checks still ran on it | new packing step |
| `checks-only` | patch in the model input, but the model part did not complete (`modelIncomplete` or `incomplete`) | `ReviewOutput` |
| `reviewed` | patch in the model input and at least one model pass completed with a report | `ReviewOutput` |

Orthogonal flag `opened`: the agent called `read_file` with `ref` head (any range) on that path in a completed pass (single mode: the file was one of the ≤15 full-file contexts). Counted separately: `contextFilesOpened` = distinct paths opened that are not in the diff. **Wording rule:** "reviewed" means "its diff was in the model input and the model finished", never "every line was analysed"; "opened" never means "fully read".

**Rule in scope** = `status: active` and scope matches ≥1 changed file that is not `removed`/`ignored` (today's `rulesForPr` over `reviewable`). Active rules out of scope are only counted.

**How a rule was covered** (`how`): `check` (exhaustive check ran) · `check+model` (partial check ran; model also reviews it) · `check-failed+model` (check skipped: `invalid-check`, `needs-workspace`, `read-failed`) · `model`.

**Result per rule:**
- Check part: `k violations` or `none found`. For a partial check the text is `none found (pattern only)`.
- Model part, first match wins: `not run` (model incomplete) → `k reported` (published model findings citing the rule) → `violated, not published` (a verdict `violated` but no published finding: append `filtered: <reason>` when a dropped finding cites the rule) → `ok` / `not applicable` (verdicts: any `violated` > any `ok` > all `not-applicable`; a verdict without `file` covers every file of the rule) → `not asked` (mode `basic`, `ruleChecks: off`) → `no verdict`.
- Count `verdictConflicts` (verdict `ok`/`not-applicable` but a published finding cites the rule) for the log only.

**Rule covered** (for the headline) = `how` is `check`, or the model part completed and the rule has `k reported`, `ok`, `not applicable` or `violated, not published`. `no verdict`, `not asked` and `not run` are **not covered by the model** (a `check+model` rule still counts its check part as covered for what the pattern tests).

**Coverage complete** = no reason from this list applies (codes are stable, used in logs and records): `model-timeout`, `model-budget`, `model-error`, `no-valid-report`, `pass-failed` (deep, one of two), `step-budget` (forced wrap-up), `missing-verdicts` (deep bounced report accepted incomplete, or rules with `no verdict` when `ruleChecks` is `ask`/`require`), `diff-over-budget`, `single-fallback` (repo download failed; reason `repo-too-large`/`download-timeout`/`download-failed`/`workspace-failed`), `checks-skipped`. Findings omitted by the cap are **not** a coverage reason (they were examined); they keep their existing status line.

### A.2 Where each datum comes from

| Datum | Exists today | Missing work |
|---|---|---|
| changed files, status, patch presence, ignore | `review-pr.ts` `files`, `reviewable` | keep per-file status instead of filtering it away |
| over-budget files | no (silent slice) | whole-file packing in `review-pr.ts`; checks over the full diff (new optional `ReviewInput.checksDiff`, used by `runChecks` when present) |
| rules in scope / out of scope | `rulesForPr`, `loaded.active` | pass both counts |
| check ran / exhaustive / partial / skipped | `runChecks` returns all | expose `checks.exhaustive: string[]`, `checks.partial: string[]` in `ReviewOutput` |
| per-rule verdicts | `ReviewOutput.ruleChecks` (agent; merged across passes) | consume it |
| ruleChecks mode | `preset.ruleChecks` | pass it |
| forced wrap-up | `AgentRunResult.forcedWrapUp` | carry through `mergeRuns` (already ORs it) and `reviewDiff` → `ReviewOutput.forcedWrapUp` |
| files opened by the agent | no | `agent/loop.ts`: collect `read_file` tool-call inputs from `result.steps` (ref head or omitted), dedupe → `AgentRunResult.filesOpened: string[]`; union in `mergeRuns` |
| fallback reason | `fallbackReason()` in `review-pr.ts` (logged) | pass to coverage |
| dropped by reason | `ReviewOutput.dropped` | count per reason |
| model incomplete / passes | exists | — |

### A.3 Exact PR summary format

Visible part (after the existing counts line, before the notes): **one line, ≤ 220 characters**. Details: collapsed, ≤ 8,000 characters, files table ≤ 25 rows (non-reviewed first, then reviewed; the rest summarised as "and N more reviewed files"), rules table ≤ 30 rows. A blank line after `<summary>` is required for the Markdown tables to render on GitHub.

```markdown
**Guardrails** · mode standard (default)

3 findings: 2 from checks, 1 from the model

Coverage: complete · 4 of 5 changed files reviewed (1 ignored) · 5 rules in scope: 2 by checks, 3 by the model (3 with a verdict)

<details><summary>What was reviewed</summary>

| File | Status |
|---|---|
| `package-lock.json` | ignored (default) |
| `src/components/RepositoryBadge.tsx` | reviewed · opened by the agent |

| Rule | How | Result |
|---|---|---|
| `colocated-tests` | check | 1 violation |
| `one-component-per-file` | check | none found |
| `layered-data-access` | check + model | check: 1 violation · model: ok |
| `english-code-spanish-ui` | check + model | check: none found (pattern only) · model: 1 reported |
| `deadline-logic-centralized` | model | not applicable |

**check** = exact result of code for what the check tests. **model** = the model's claim; it can be wrong.
Filtered before publishing: 1 duplicate of a check finding. Agent: 3 steps, 1 file opened outside the diff. 0 other active rules out of scope.
</details>
```

Incomplete runs change only the start of the visible line and add rows/lines in the details:
- `Coverage: partial (model ran out of time: checks only) · 0 of 5 changed files reviewed by the model · 2 rules by checks, 3 not reviewed`
- `Coverage: partial (1 of 2 passes failed) · ...` · `Coverage: partial (3 files over the diff budget) · ...` · `Coverage: partial (repo download failed: single-call review; 2 checks not run) · ...` · `Coverage: partial (no verdict for 2 rules) · ...`. Several reasons: first two, then `+N more`.
- `coverage: "line"` prints only the visible line; `"off"` prints nothing. The CLI prints the same content (human) and a `coverage` object (JSON).

### A.4 Tests and acceptance (v0.8.0)

- Unit (`src/core/coverage.test.ts`, mock data only): each file status and precedence; each `how`; each model-result branch including `violated, not published` with and without a dropped finding; verdict without `file`; `basic` → `not asked`; every reason code; `verdictConflicts`; deterministic ordering; visible line ≤ 220 chars with 300 files and 40 rules; details ≤ 8,000 chars.
- Unit (`agent/loop`): `filesOpened` collects head `read_file` paths across steps, ignores `ref: base`, dedupes; `mergeRuns` unions them.
- Cloud (`review-pr.test.ts`, mocked Octokit): a PR with one removed, one ignored, one patch-less and one file beyond the budget gets the right statuses; the packed diff never cuts a file; a check finding on an over-budget file is still published; fallback to single mode shows `single-fallback` in the summary.
- Log: `review.analyzed` gains numbers only: `filesChanged, filesReviewed, filesIgnored, filesRemoved, filesNoDiff, filesOverBudget, filesChecksOnly, filesOpened, rulesInScope, rulesByCheck, rulesByModel, rulesWithVerdict, verdictConflicts, coverageComplete` and `coverageReasons` (array of codes; `sanitizeLogFields` keeps string arrays).
- Real verification (orchestrator, D-023): v071 clone, `v73/case-reminders` standard and deep, `v73/clients-page` standard (≤ US$0.08). Expected: case-reminders shows `english-code-spanish-ui` as `check + model` with a check violation and a model report; clients-page `Coverage: complete`, 0 findings. Also record the **verdict accuracy** of `ruleChecks` against the answer key (risk R2 below). Production: the user adds `guardrails:standard` to causas PR #9 (≤ US$0.03); expected summary matches the example above in structure.
- Cost: executor tokens 150–180k (two runs, T2 + T3); Z.ai ≤ US$0.12.

---

## §B. Review records, persistence and the consolidated report

### B.1 Review record v1 (the "final report per review", machine-readable)

Provider-neutral type in `src/core/record.ts`, written into the summary as the last line:
`<!-- guardrails:record:v1 <base64url(JSON)>.<hmac> -->` — `hmac` = first 16 hex chars of HMAC-SHA256 over the base64url payload with `GUARDRAILS_RECORD_KEY` (new optional env var); `-` when the key is not set. Cap 8 KB; above it the `findings` list is cut from the end and `findingsTruncated: true` is set.

```ts
export interface ReviewRecordV1 {
  v: 1; provider: "github" | "gitlab" | "local"; repo: string; number: number;
  headSha: string; baseSha: string; fromSha: string | null; trigger: string;          // opened | synchronize | labeled | ...
  mode: ModeName; modeSource: ModeSource; engine: "agent" | "single"; model: string; fallback: string | null;
  at: string; ms: number; costUsd: number | null; tokens: { in: number; cached: number; out: number }; steps: number;
  passes: number; passesFailed: number; version: string;                              // guardrails package version
  coverage: { files: Record<FileCoverageStatus, number>; opened: number; rulesInScope: number; byCheck: number;
              byModel: number; withVerdict: number; complete: boolean; reasons: CoverageReason[] };
  counts: { findings: number; fromChecks: number; fromModel: number; merged: number; omitted: number;
            dropped: Partial<Record<DropReason, number>> };
  findings: { fp: string; rule: string | null; origin: "check" | "llm"; type: string; sev: string;
              conf: number; file: string; line: number; inline: boolean }[];
  findingsTruncated?: true;
}
```
`fp` = existing `fingerprint(repo, finding, anchorText)` (`findings/fingerprint.ts`), anchor text from the added diff line. Reading rule: a record is trusted only if the review/note author is the App's bot user (`<slug>[bot]`, slug from new env `GITHUB_APP_SLUG`); HMAC verified when the key is available, otherwise the report marks the record `unverified`.

### B.2 What is stored and retention

| Store | Retention | Content |
|---|---|---|
| Marker in the PR/MR summary | as long as the PR/MR exists (provider's retention; deletable by the user) | `ReviewRecordV1` only |
| Postgres (deferred) | reviews 365 days; findings and feedback 180 days; `usage_daily` 400 days; deliveries 14 days; purge within 24 h on uninstall | same fields + provider comment id, outcome, feedback rows (kind, signal, actor association, source, time; **no login**) |
| Logs | Vercel's retention | numbers and codes only (unchanged deny list) |

Never stored anywhere: source code, diff/patch text, finding title/body/suggestion, evidence notes, PR title/description, commit messages, logins.

### B.3 Feedback capture

- **Now (report time, v0.9):** the report CLI reads live signals per PR with one GraphQL query: `reviewThreads { isResolved isOutdated comments(first: 5) { databaseId author { login } path line originalLine reactionGroups { content users { totalCount } } } }`. Only threads whose first comment is by the App bot. Matching to record findings by `(path, line)` among `inline: true` findings of that review, falling back to `originalLine`.
- Signals (PLAN §5.1 subset, no LLM): `THUMBS_UP`/`HEART`/`HOORAY` +1; `THUMBS_DOWN`/`CONFUSED` −1; resolved and outdated +1 ("likely fixed"); resolved not outdated −0.5; closed PR with no signal → `ignored` (not rejected). Reactions by bots excluded; reactor association is not available per reaction in `reactionGroups`, so v0.9 counts all human reactions and says so.
- **Later (with DB):** sweep on `pull_request` action `closed` (already delivered, currently ignored) writes feedback rows; same query, same mapping. No new event or permission.

### B.4 Consolidated report (first slice, v0.9.0)

`pnpm guardrails report --repo <owner/name> [--since 30d] [--until <date>] [--format md|csv] [--out <path>]` with `GITHUB_TOKEN` (the user's read token, for example from `gh auth token`). GitLab later: `--gitlab-project <group/name>` with `GITLAB_TOKEN`, `GITLAB_BASE_URL`. `fetch` only (no Octokit, see gotchas). API cost: 1 list call per 100 PRs + 1 reviews call + 1 GraphQL call per PR.

Markdown sections: (1) scope and data quality: period, PRs, reviews with records, legacy App reviews without a record, unverified records; (2) activity: reviews by trigger and mode, incremental share; (3) findings: total, by origin (check/model), by severity, by rule (top 10) and without rule; (4) coverage: median files-reviewed share, reviews with partial coverage and top reasons, rules most often without a verdict; (5) acceptance per origin and per rule: 👍, 👎, likely fixed, resolved unchanged, no signal, share with any signal — labelled "signals, not ground truth"; (6) cost and time: sum and mean estimated cost per mode ("estimate; the Z.ai balance is the truth"), p50/p95 duration. CSV: one row per finding (record fields + signals + PR number + review time).

Audience: repo owner. Next slices, in order, only when asked: (a) `/guardrails report` PR comment on demand (needs the `issue_comment` event subscription: user action, no permission change expected but verify); (b) hosted page with GitHub login (PLAN B28), after Postgres.

### B.5 Postgres (deferred): trigger and shape

Start it when **any** of: a second repository or GitLab project is connected; the user wants the daily spend cap; learning from feedback (§D.4) is wanted; the report takes > 60 s. Shape: Neon via Vercel Marketplace (user provisions; free plan), Drizzle, tables `reviews` (record columns, `unique(provider, repo, number, head_sha, trigger_seq)`), `findings`, `feedback` (`unique(finding_id, kind, actor_hash)`), `usage_daily` (`provider:repo` or installation scope, day, reviews, tokens, cost), `deliveries` (durable dedupe). `ReviewStore` interface with `MarkerStore` (existing) and `PgStore`; DB writes in `after()` never block publishing; the report reads the DB when `DATABASE_URL` is set, markers otherwise. Needs its own short plan (planner, not hyper) when triggered.

---

## §C. GitLab (v0.11.0)

### C.1 Split of `src/cloud`

| Piece | Today | GitLab-ready form |
|---|---|---|
| Signature/token check | `github.ts verifySignature` (HMAC) | per provider; GitLab: `X-Gitlab-Token` equals `GITLAB_WEBHOOK_SECRET` (timing-safe) |
| Event parsing, actions, bot filter | `webhook.ts` | per provider → common `ChangeEvent { provider, repo, number, headSha, baseSha, action, draft, isFork, labels, label?, isBot }` |
| Auth client | `installationOctokit` | GitHub App token; GitLab `PRIVATE-TOKEN` header with `fetch` |
| Change metadata + file list + patches | `pulls.get`, `pulls.listFiles` | `ProviderClient.getChange()` → `{ title, description, labels, baseSha, headSha, files: { path, oldPath, status, patch \| null, additions, deletions }[] }` |
| Read file at ref | `repos.getContent` | `ProviderClient.readFile(path, ref)` (already the `ReadAtRef` shape of `review-rules.ts`) |
| Archive | `TarballOctokit` inside core | `TarballWorkspace.create({ fetchArchive(ref, signal): Promise<Uint8Array> })` — removes the D-002 leak |
| Publish | `pulls.createReview` (one batch) | `ProviderClient.publish({ summary, inline[] })` → returns which inline comments failed (moved to the summary as orphans) |
| Failure notice | `reportReviewFailure` | `ProviderClient.notice(text)` |
| Records | — | `ProviderClient.listRecords(repo, number?)` for incremental state and the report |
| Reusable as is | core; `review-rules.ts`; `cloud/diff.ts commentableLines`; `log.ts`; `summary`/`coverage`/`record`; `selectMode` (labels, description); `evaluateTriggers`; `DeliveryDedupe`; `classifyFailure` (except the GitHub rate-limit header) | |

The orchestration in `review-pr.ts` becomes provider-neutral `review-change.ts`; `src/cloud/github/` and `src/cloud/gitlab/` hold the adapters; routes `app/api/webhooks/github/route.ts` (unchanged URL) and new `app/api/webhooks/gitlab/route.ts`.

### C.2 GitLab mapping

| Need | GitLab |
|---|---|
| Events | "Merge request events" (`X-Gitlab-Event: Merge Request Hook`, `object_kind: merge_request`). Review on `action` `open`, `reopen`, `update` **with** `object_attributes.oldrev` (new commits), and `update` whose `changes.labels` add/remove a `guardrails:*` label. Draft: `object_attributes.draft`. Fork: `source_project_id != target_project_id`. Dedupe id: `X-Gitlab-Event-UUID` |
| Auth of the webhook | secret token header `X-Gitlab-Token` (plain shared secret, not an HMAC); reject 401 otherwise. Newer GitLab versions may offer signed webhooks: verify on the user's instance |
| API token | Least scope that can post: **scope `api`, role Reporter** (read repo + comment; cannot push). Project access token on self-managed or paid gitlab.com; on **gitlab.com Free project/group access tokens are not available** (to verify), so use a dedicated bot account's personal access token, member of the project as Reporter. Expiry ≤ 365 days |
| Rules/config (D-007) | `GET /projects/:id/repository/files/:path/raw?ref=<diff_refs.start_sha>` — `start_sha` is the target branch head, the equivalent of GitHub `pr.base.sha` (`base_sha` is the merge-base) |
| Diff | `GET /projects/:id/merge_requests/:iid/diffs` (paginated): `old_path`, `new_path`, `new_file`, `renamed_file`, `deleted_file`, `diff` (no file headers: add `--- a/`/`+++ b/` as today); empty/too-large diff → `no-diff` |
| Archive | `GET /projects/:id/repository/archive.tar.gz?sha=<sha>`; one top-level directory, so `strip: 1` works. gitlab.com rate-limits archive downloads (verify limits); on failure the existing single-mode fallback reads files via the files API |
| Fork MRs | head commit is reachable in the target project through `refs/merge-requests/:iid/head`; archive by `sha=<head_sha>` (verify) |
| Inline comments | `POST /projects/:id/merge_requests/:iid/discussions` with `position[position_type]=text`, `base_sha`, `start_sha`, `head_sha` (from `diff_refs`), `old_path`, `new_path`, `new_line`. Only on **added** lines in v0.11 (context lines need `old_line` too); a 400 moves the finding to the summary. Optional: draft notes + bulk publish to post as one review (verify availability) |
| Summary | `POST /projects/:id/merge_requests/:iid/notes`, posted **after** the discussions; carries the record marker (HTML comments are hidden in GitLab Markdown: verify) |
| Bot filter | ignore events whose `user.id` is the bot user; notes do not trigger MR events |
| Config (MVP) | env `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_PROJECT_IDS` (allowlist; anything else → 202 ignored) |

Both providers write the same `ReviewRecordV1` (field `provider`), so the report and incremental logic work unchanged.

### C.3 Effort, position and what the user must provide

- Effort: T8 refactor (no behaviour change) 90–110k subagent tokens; T9 GitLab adapter 110–140k; live verification by the orchestrator ≤ US$0.10 Z.ai.
- Position: v0.11.0 (after records and efficiency; Postgres not required).
- **Cannot be verified without a real GitLab project:** payload shapes on the user's version, whether `update` carries `oldrev` as expected, position acceptance of inline discussions, archive rate limits, fork MRs, token role sufficiency, HTML-comment hiding, draft-notes availability.
- **User provides:** a GitLab project (a mirror of causas-viewer is enough, public or private), the token (bot account PAT or project access token, scope `api`, role Reporter), a project webhook to `https://guardrails-augusto-pastranas-projects.vercel.app/api/webhooks/gitlab` with a secret, and the four env vars in Vercel. Plus one clean and one seeded MR.

---

## §D. D-019 and D-020 resolved

### D.1 Where state lives
Incremental review state and per-review history: **signed marker** (§B.1) now; Postgres primary when triggered, marker as fallback. Rule-source state: **hash line in the rules.md preamble** (§D.3). Lock file written by the App: rejected (needs `contents: write`).

### D.2 `init` on install → init on first review (v0.12+, after this window)
Condition: base has no `.guardrails/rules.md` and no `config.rules`. Run `runInit` over the **base** tree of the existing `TarballWorkspace` (a thin adapter that serves `ref: base` as the default ref), model `zai:glm-5.3-flash`, cap US$0.02, timeout 60 s, concurrent with the review, failure only logged. Output: collapsed section "Suggested rules for this repository (N)" with a ready-to-commit rules.md block (`status: suggested`) whose preamble carries the source hash line. Repeat control: in-memory per (repo, base SHA) now; once per repo per hash set with the DB. The `installation` event is not used (and not needed). No permission change.

### D.3 Incremental refresh and obsolete rules
Preamble line: `<!-- guardrails:sources v1 CLAUDE.md=<sha256-12> AGENTS.md=<...> .oxlintrc.json=<...> -->`, hashes over the normalized content read at base. On a PR that changes one of the collector's sources and when rules.md exists: synthesize from the **changed sources only** (flash, cap US$0.01), drop candidates whose id or text already exists, and show "Proposed rule updates (N)" collapsed. When a rule's `source` file is deleted by the PR or missing at base: "source removed: consider `status: disabled`". `source: user` rules are never flagged. When base hashes differ from the preamble and the PR does not touch sources: one line "Rule sources changed since the rules were generated (<files>)", no model call. Nothing is ever written by the App.

### D.4 Learning from feedback (needs Postgres; first step is capture)
Per rule, over 90 days, feedback from owners/members/collaborators or the PR author: if rejections ≥ 3 from ≥ 2 PRs and rejections ≥ 2 × acceptances + 1 → the report and the next review touching the rule suggest narrowing or disabling it (never automatic). Findings without a rule, grouped by normalized title + type: same threshold → confidence −0.15 (PLAN §5.2) and a "suggested negative instruction"; acceptances ≥ 3 from ≥ 2 PRs → propose a new rule as `suggested`. `high` + `security` never penalised. Precondition to enable: ≥ 30% of findings with any signal (PLAN R4); otherwise add a "Was this useful? 👍/👎" line to inline comments first.

### D.5 Efficiency, in priority order

| # | Item | Version | Expected saving | How to measure truthfully |
|---|---|---|---|---|
| 1 | Skip the model on trivial diffs: every changed file matches `skipModelPaths` (default lockfiles, `**/*.md`, `docs/**`, images, `.gitignore`); checks still run; summary says so | v0.10.0 | 100% of model cost on those PRs (~US$0.004–0.018 each in standard) | count of records with `engine: "none"` × mean standard cost from records |
| 2 | `basic` → `zai:glm-5.3-flash` (preset `model`, overridable in config and `GUARDRAILS_MODEL_BASIC`) | v0.10.0 | list-price ratio 9.3× input, 8.8× output → −85–90% on basic reviews | seeded suite basic × 6 branches: recall and cost vs glm-5.3; keep glm-5.3 if flash misses a seeded problem that glm-5.3 basic finds |
| 3 | Cost and duration visible by default (footer on; `GUARDRAILS_SHOW_STATS=0` hides) + record | v0.9.0 | 0 (enabler) | — |
| 4 | Incremental re-review on `synchronize` from the last trusted marker: `compare lastSha...head`; if ancestor, review only PR files changed since `lastSha` (their PR-diff hunks), skip fingerprints already published; full review on force-push (diverged), base SHA change, mode change, rules/config change, or `deep` | v0.10.0 | PLAN §9 estimate −60–80% per extra push (unmeasured here) | a test PR with 2 pushes: tokens of the second review full vs incremental, from records |
| 5 | Prompt-prefix order: keep instructions stable per repo; move PR-specific parts (partial-check locations, deep focus) into the user prompt | v0.10.0 | small; cache already works within a run | `tokens.cached / tokens.in` from records before/after; skip the change if the ratio is already ≥ 0.5 |
| 6 | Daily spend cap per installation/project | with Postgres | protection, not saving | `usage_daily`; until then the prepaid balance is the hard stop |

**Truth source for spend:** the prepaid Z.ai balance. Before and after each verification batch the user reads the balance; calibration factor = Δbalance ÷ Σ `costUsd` of the batch's records. Record it in the CHANGELOG "What we observed". If > 1.2, show cost as "est." and apply the factor in the footer. Separate Z.ai keys for local and Vercel (proposed on 2026-09-24) make the split visible, if the user created them.

---

## Files to touch (by the executor tasks; none by this plan)

| File | Task | What to change (concrete) |
|---|---|---|
| `guardrails/src/core/findings/dedupe.ts` | T1 | in `mergeAcrossPasses`, add an extra line to `also` only if it lies inside an evidence range of the finding it came from (same file) and differs from the primary line; never drop the finding |
| `guardrails/src/core/workspace/local.ts` | T1 | when `headRef` is set: `readFile` head via `git show <headRef>:<path>` (reject non-blob, e.g. mode 120000, via `git ls-tree`); `grep`/`findReferencesByName` via `git grep ... <headRef> -- <pathspec>` and strip the `rev:` prefix |
| `guardrails/src/core/spend.ts`, `guardrails/src/cli/review.ts` | T1 | `profileFromDiff({ diffChars, files, preset, engine })`: prefix = 4k + diffChars/3.5 tokens; steps = min(preset.maxSteps, 2 + files); input = steps × prefix + 2.9k × steps(steps−1)/2; cached share 0.5; output = 0.4k × steps + 1.5k; × passes. Use it in `cli/review.ts:283` |
| `guardrails/src/core/coverage.ts` (+ test) | T2 | new: types of §A, `computeCoverage`, `formatCoverageLine`, `formatCoverageDetails` |
| `guardrails/src/core/agent/loop.ts`, `agent/passes.ts` | T2 | `filesOpened` in `AgentRunResult`; union in `mergeRuns` |
| `guardrails/src/core/review.ts`, `guardrails/src/core/types.ts` | T2/T3 | `ReviewOutput`: `checks.exhaustive`, `checks.partial`, `forcedWrapUp`, `filesOpened`, `ruleChecksMode`; `ReviewInput.checksDiff?` used by `runChecks` |
| `guardrails/src/core/summary.ts` | T2 | accept an optional coverage line/details and place them after the counts line |
| `guardrails/src/core/config.ts` | T3, T6 | `coverage: "details" \| "line" \| "off"` (default `details`); T6: `skipModelPaths`, per-mode `models` |
| `guardrails/src/cloud/review-pr.ts` | T3, T4, T7 | per-file statuses, whole-file packing, `checksDiff`, coverage in summary and log; T4 record marker; T7 incremental |
| `guardrails/src/cli/review.ts` | T3 | coverage in human and JSON output |
| `guardrails/src/core/record.ts` (+ test) | T4 | `ReviewRecordV1`, `encodeRecord`, `decodeRecord`, HMAC, 8 KB cap |
| `guardrails/src/cloud/github-records.ts` (+ test) | T4 | list the PR's reviews, keep bot-authored ones (`GITHUB_APP_SLUG`), decode latest record |
| `guardrails/src/cli/report.ts`, `guardrails/src/cli/guardrails.ts` | T5 | `report` subcommand, fetch-based REST + GraphQL, Markdown + CSV |
| `guardrails/src/core/modes.ts`, `guardrails/src/core/pricing.ts` | T6 | preset `model` (basic → `zai:glm-5.3-flash`) |
| `guardrails/src/core/agent/prompts.ts`, `guardrails/src/core/rules/format.ts`, `guardrails/src/core/prompt.ts` | T7 | move PR-specific notes from instructions to the user prompt |
| `guardrails/src/core/workspace/tarball.ts` | T8 | `fetchArchive` injection instead of `TarballOctokit` |
| `guardrails/src/cloud/provider.ts`, `src/cloud/review-change.ts`, `src/cloud/github/*`, `src/cloud/gitlab/*`, `app/api/webhooks/gitlab/route.ts` | T8, T9 | §C |
| `guardrails/.env.example`, `guardrails/README.md` | T4, T6, T9 | `GUARDRAILS_RECORD_KEY`, `GITHUB_APP_SLUG`, `GUARDRAILS_MODEL_BASIC`, `GITLAB_*` |
| `guardrails/CHANGELOG.md`, `guardrails/package.json` | every task | version entry and bump (the orchestrator writes "What we observed") |

## Implementation steps (strict order)

Rules for every task: one executor run, handoff ≤ 60 lines written by the orchestrator from this plan (exact file list, the snippet of the relevant section, acceptance), agents must not read `PLAN-DETAILED.md`, `CHANGELOG.md` or `DECISIONS.md` whole (point to sections), no pushes by agents, max 2 subagents in parallel (in practice these are sequential: most tasks touch `review.ts`/`review-pr.ts`). Real runs and CHANGELOG "What we observed" are done by the orchestrator (D-023). Stop rule: if a task passes 1.5× its token estimate, resume (SendMessage) with a narrower instruction or split; never restart from scratch.

| Step | Version | Task | Agent | Acceptance (measurable) | Subagent tokens | Z.ai cap |
|---|---|---|---|---|---|---|
| 0 | — | User judges the extra `deep` findings (listed in CHANGELOG v0.7.0 and v0.7.3: "export ignores active filters", "CSV formula injection", "raw status enum", "0 business days on weekend", "`today` recomputed per render") | user | answer: useful / noise per item | 0 | 0 |
| 1 | v0.7.4 | T1: "Also at" validation + LocalWorkspace head reads + diff-sized estimate (+ deep `minConfidence` 0.4 → 0.6 only if step 0 says "noise") | executor | unit tests: extra line outside evidence dropped, inside kept, finding never dropped; working tree ≠ head → `readFile`/`grep`/`findReferencesByName` return head content; estimate for a 3-file 120-line diff within 3× of the CHANGELOG measured standard costs; `pnpm check`, `pnpm build` green | 70–90k | 0 |
| 2 | v0.7.4 | V1: 2 deep runs `v73/case-reminders` + 1 standard `v73/csv-export` on the v071 clone (checkout of the branch no longer required for head reads: run with the branch **not** checked out once, to prove it); every "Also at" line checked by hand | orchestrator (user authorization) | 3 comments for 3 problems, every "Also at" line is the same problem; check findings identical to v0.7.3; dry-run estimate printed vs real cost ratio ≤ 3 | 0 | 0.12 |
| 3 | v0.8.0 | T2: core coverage (§A.1–A.4 core parts) | executor | unit tests of §A.4 (core, loop) green; no change in published findings on the existing tests | 80–100k | 0 |
| 4 | v0.8.0 | T3: cloud + CLI integration, whole-file packing, checks over full diff, config `coverage`, log fields | executor (**resume T2's agent**) | cloud tests of §A.4 green; summary of the example renders ≤ 220-char visible line | 60–80k | 0 |
| 5 | v0.8.0 | V2: local standard/deep runs (§A.4) + verdict accuracy vs answer key; push after gate; user adds `guardrails:standard` to PR #9 | orchestrator + user | expectations of §A.4; deploy success; PR #9 summary has the coverage line and details | 0 | 0.12 |
| 6 | v0.9.0 | T4: `ReviewRecordV1`, marker write, bot-authored read, HMAC, footer on by default | executor | round-trip encode/decode; tampered payload → `unverified`; non-bot author ignored; 8 KB cap with 200 findings; marker is the last line of the body; no content fields in the record (test lists the keys) | 70–90k | 0 |
| 7 | v0.9.0 | T5: `guardrails report` (md + csv), live feedback signals | executor | fixture-based tests (recorded REST/GraphQL JSON, fetch mocked): all six sections; legacy reviews counted; CSV header fixed; no Octokit import in `src/cli/report.ts` | 80–100k | 0 |
| 8 | v0.9.0 | V3: push; one prod review (label on PR #9) to create a record; run the report on causas-viewer with the user's token | orchestrator + user | record decodes and verifies; report lists 9 PRs, 1+ with record, legacy count correct | 0 | 0.03 |
| 9 | v0.10.0 | T6: `skipModelPaths` + basic on flash + overrides | executor-mecanic | tests: docs-only diff → no model call, checks run, summary line; basic preset resolves to flash; config/env override wins | 40–60k | 0 |
| 10 | v0.10.0 | T7: incremental re-review + prompt-prefix reorder | executor | tests: ancestor → only files changed since `lastSha`; diverged/base-change/mode-change/`deep` → full; published fingerprints not repeated; untrusted marker ignored; instructions identical across two PRs of the same repo | 90–110k | 0 |
| 11 | v0.10.0 | V4: basic × 6 branches on flash (b45 clone) vs glm-5.3; a 2-push test PR (user approves pushing a new branch to causas-viewer) | orchestrator + user | recall rule of §D.5 #2; second push reviewed incrementally with fewer input tokens than a full review; balance delta recorded | 0 | 0.15 |
| 12 | v0.11.0 | T8: provider interface refactor, `fetchArchive` injection | executor | no behaviour change: all existing tests green without edits to assertions; `src/core` has no Octokit/GitHub route strings (grep test) | 90–110k | 0 |
| 13 | v0.11.0 | T9: GitLab adapter + route + env | executor | fixture tests: token check 401, event filtering (`oldrev`, labels, draft, allowlist), diff mapping, position payload, failed discussion → orphan in summary, record in the note | 110–140k | 0 |
| 14 | v0.11.0 | V5: live MRs on the user's GitLab project (1 clean, 1 seeded) | orchestrator + user | clean: 0 findings, coverage complete; seeded: expected findings inline; report `--gitlab-project` works | 0 | 0.10 |

Totals: **~690–880k subagent tokens** over 9 executor runs (mean ~88k, below the 117k historical mean), **Z.ai caps US$0.52, expected ~US$0.25–0.35** (≈ 10% of the ~US$3.5 balance). Minimum path if the budget tightens: steps 0–8 only (~400–460k tokens, ≤ US$0.27) answer both of the user's questions for GitHub; re-decide after.

How to use fewer subagent tokens: handoffs ≤ 60 lines with the snippets from this plan; resume the same agent for the paired task (T2→T3, T8→T9) instead of a fresh one; `executor-mecanic` (Haiku) for T6; the orchestrator does verification, CHANGELOG, DECISIONS, metrics and pushes directly; no planner run for tasks designed here (only Postgres and init-on-first-review need a short `planner` run later); record `usage.totalTokens` for every run in `runs.jsonl`.

## Done criteria (checklist)

- [ ] v0.7.4: `dedupe.ts` validates "Also at" lines; `local.ts` reads head via git; `spend.ts` has `profileFromDiff`; CHANGELOG v0.7.4 with V1 results; `package.json` 0.7.4.
- [ ] v0.8.0: `src/core/coverage.ts` exists with the §A.1 definitions; `review.analyzed` has the coverage number fields; `review-pr.ts` no longer slices mid-file (`fullDiff.slice(0, MAX_DIFF_CHARS)` removed); PR #9 production summary shows the coverage line and a collapsed details block; CHANGELOG includes verdict accuracy vs the answer key.
- [ ] v0.9.0: every App review body ends with a `guardrails:record:v1` marker; `guardrails report --repo blanck1945/causas-viewer` prints the six sections and writes a CSV; no content fields in records (test).
- [ ] v0.10.0: docs-only PRs skip the model; `basic` uses flash (unless V4 recall rule fails, then reverted and recorded); second push of the test PR reviewed incrementally; balance-based calibration factor recorded.
- [ ] v0.11.0: `src/core` free of GitHub-specific calls (grep test); GitLab webhook reviews an MR on the user's project; report works for it.
- [ ] D-027..D-039 appended to `DECISIONS.md` (Spanish) with the statuses given below; each version's CHANGELOG has did / observed / next.
- [ ] Verification command per task: `cd guardrails && pnpm check && pnpm build`, secret scan of tracked files = 0 hits, then the real run of its V-step before any push (D-023).
- [ ] Verification mode: spec (tests) + prod (V-steps).

## Assets (verify before ship)

| URL / ID | Use | Notes |
|---|---|---|
| `https://guardrails-augusto-pastranas-projects.vercel.app/api/health` | deploy check | expect 200 |
| `github.com/blanck1945/causas-viewer/pull/9` | V2/V3 prod runs by label | user adds the label |
| `https://guardrails-augusto-pastranas-projects.vercel.app/api/webhooks/gitlab` | GitLab webhook target | exists only after T9 is deployed |
| GitLab REST v4 docs (merge request events, discussions positions, archive, access tokens) | T9 | re-check field names and token availability on the user's tier before T9 |

## Benchmark reference (read-only)

Not applicable.

## Risks and what to validate first

| # | Risk | Validate first by | Kill criterion |
|---|---|---|---|
| R1 | The coverage block makes the summary long and noisy | V2 on PR #9 | visible part > 1 line or the user finds it noisy → default `coverage: "line"` |
| R2 | Model verdicts ("ok") read as guarantees; verdict quality unknown | V2: verdicts vs answer key on seeded branches | accuracy < 80% → show model verdicts only inside details and never count them in the headline |
| R3 | Whole-file packing changes behaviour on big PRs | T3 tests + a synthetic 250k-char diff test | any check finding lost → block release |
| R4 | Marker forged or edited to skip reviews or distort reports | T4 tests (non-bot author, tampered HMAC) | — |
| R5 | GitHub keeps HTML comments in the raw review body (assumed) | V3: GET the review body and decode | if stripped → store the record in a separate bot comment instead |
| R6 | Feedback too scarce for §D.4 (PLAN R4) | report "share with any signal" after 2–4 weeks | < 30% → add the "useful? 👍/👎" line before learning |
| R7 | flash too weak for `basic` | V4 recall rule | revert basic to glm-5.3 (one config line) |
| R8 | Incremental misses cross-file effects on unchanged files | T7 design: `deep` and mode changes force full | user sees a miss → default incremental only for `basic`/`standard` (already) and add a periodic full review |
| R9 | GitLab unknowns (§C.3) | V5 only | if positions fail → post everything in the summary note first, inline later |
| R10 | Z.ai balance runs out mid-verification | caps per V-step; user reads the balance before each batch | stop all real runs when balance < US$1 |
| R11 | Subagent tokens overrun (the user's concern) | per-task estimate, stop rule at 1.5× | cut to the minimum path |
| R12 | `tsx` + Octokit for the report CLI | T5 acceptance forbids Octokit there | — |

## Out of scope

Postgres implementation, dashboard, billing, Check Runs, any App permission or event change, `issue_comment` commands, init on first review and rule refresh implementation (designed in §D, scheduled after v0.11.0), embedding-based feedback filter (PLAN F2c), LLM judge / Phase 0 (B11–B17), Bitbucket, self-hosting, making causas-viewer private.

## Open questions (only the user can answer; each has a default)

- [ ] **Q1** Show coverage in every review as one line plus a collapsed details block? → default: yes (`coverage: "details"`).
- [ ] **Q2** The extra low-confidence `deep` findings (step 0): useful or noise? → default: keep `deep` at 0.4 until you answer.
- [ ] **Q3** OK to keep file paths and rule ids (never code) in the hidden record of each review? → default: yes.
- [ ] **Q4** Is the consolidated report for you only (repo owner) for now, as a Markdown/CSV file? → default: yes.
- [ ] **Q5** May the report CLI use your local GitHub read token (`gh auth token`)? → default: yes, read-only use.
- [ ] **Q6** Set a new secret `GUARDRAILS_RECORD_KEY` (and `GITHUB_APP_SLUG=guardrails-boogiepop`) in Vercel and `.env.local` to sign records? → default: yes; without it records are trusted by bot author only.
- [ ] **Q7** GitLab: gitlab.com or self-managed, and which tier? → default: gitlab.com Free with a dedicated bot account token (scope `api`, role Reporter).
- [ ] **Q8** GitLab before Postgres (v0.11.0)? → default: yes.
- [ ] **Q9** When do you want Postgres (Neon free via Vercel)? → default: only at a §B.5 trigger.
- [ ] **Q10** Daily spend cap value once Postgres exists? → default: US$1 per day per repository.
- [ ] **Q11** Will you read the Z.ai balance before and after each verification batch (and did you create separate local/Vercel keys)? → default: yes to the first, unknown to the second.
- [ ] **Q12** Accept `glm-5.3-flash` for `basic` if it finds the same seeded problems? → default: yes.
- [ ] **Q13** Ceiling for subagent tokens on this roadmap? → default: ~900k, with the minimum path (~460k) as the first checkpoint.

**User actions or permissions needed:** authorization to run the CLI on the Temp clones (steps 2, 5, 11); adding labels on causas PR #9 (steps 5, 8); approving a push of a new test branch to causas-viewer (step 11); env vars in Vercel (Q6, GitLab); a GitLab project, token and webhook (step 14); Neon provisioning only when triggered. No App permission increase is proposed anywhere.

## Proposed DECISIONS entries (orchestrator appends in Spanish)

| Id | Title | Status | Why (one line) |
|---|---|---|---|
| D-027 | Coverage report in every review: what was examined, with check guarantees and model claims labelled apart | Planificada (v0.8.0) | The user asked "how much was covered"; the data exists (`ruleChecks`, checks) but is hidden |
| D-028 | The model's diff budget packs whole files; files that do not fit are declared and checks run on the full diff | Planificada (v0.8.0) | `review-pr.ts` cuts the diff mid-file silently, which makes any coverage claim false |
| D-029 | Review record v1: hidden, signed marker in the review summary; the provider is the first store | Planificada (v0.9.0) | Zero infra, provider-neutral, and it doubles as incremental state (Q4) |
| D-030 | Stored data is metadata only: no code, diff, titles, bodies or logins | Planificada (v0.9.0) | Privacy (PLAN §8); content stays in GitHub/GitLab |
| D-031 | Consolidated report first as a CLI (Markdown/CSV) from records plus live provider feedback; dashboard later | Planificada (v0.9.0) | Value before a DB, hosting or new permissions |
| D-032 | Incremental re-review from the last trusted marker; full review on force-push, base, rules or mode change and in `deep` | Planificada (v0.10.0) | Resolves the D-019/D-020 state question without a DB |
| D-033 | Efficiency order: skip trivial diffs, flash for `basic`, cost visible by default, incremental, prompt-prefix order, daily cap with the DB; spend measured by the prepaid balance | Planificada (v0.9.0–v0.10.0) | Savings per effort; our cost is an estimate (D-011) |
| D-034 | GitLab through provider adapters; single project via env; project/bot token with scope `api`, role Reporter; after records, before the DB | Planificada (v0.11.0) | The user wants GitLab reports; D-002 makes it an adapter |
| D-035 | `TarballWorkspace` receives an archive-fetch function instead of an Octokit | Planificada (v0.11.0) | Removes a GitHub dependency from the core (D-002) |
| D-036 | Postgres (Neon + Drizzle) deferred until a trigger: second repo/project, daily cap, learning, or report > 60 s | Planificada | Nothing before v0.11 needs it |
| D-037 | `init` on install becomes init on the first review of a repo without rules, as a collapsed proposal; no new permission | Planificada (after v0.11.0) | At install time there is nowhere to comment without `issues: write`; resolves Q5 of D-019 |
| D-038 | Rule refresh keyed by source hashes in the rules.md preamble; proposals only on PRs that change sources; obsolete rules flagged, never removed | Planificada (after v0.11.0) | No write permission, no model call when nothing changed, D-005 intact; resolves D-019's obsolete-rules question |
| D-039 | Learning from feedback: rule-level suggestions with thresholds (≥3 rejections from ≥2 PRs, R ≥ 2A+1, 90 days), never automatic | Planificada (with the DB) | Explainable and safe; the embedding filter stays for later |

Also mark **D-019** and **D-020** as "Reemplazada en parte por D-032, D-033, D-037, D-038, D-039" (keep them; add the cross-references).

---

## Execution

_Pending — do not execute until explicitly requested._
