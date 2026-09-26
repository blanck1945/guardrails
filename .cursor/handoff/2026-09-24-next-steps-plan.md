# Plan: Guardrails next steps (unblock v0.7.1, release, self-review, backlog order, consumption)

**Created:** 2026-09-24 18:26
**Original request:** Baking PLAN-ONLY. Decide the immediate blocker, the release sequence for the unpushed work, whether Guardrails reviews its own repo, the next 3 tasks, a consumption plan, process hygiene, and risks/open questions.
**Handoff:** `.cursor/handoff/2026-09-24-next-steps-plan.md`
**Ground truth read:** `2026-09-24-guardrails-context.md`, `DECISIONS.md` (D-001..D-021), `2026-09-24-v0-7-1-partial-check-coverage.md`, `guardrails/CHANGELOG.md`, `guardrails/CLAUDE.md`, `PLAN-DETAILED.md` §7, §10, §11.

## Objective

Get the already-built work (v0.6.1, v0.7.0, v0.7.1) into production without shipping a known regression, and set the order of the next work so it spends as few subagent tokens and Z.ai dollars as possible.
**Do not touch:** product code (this is a plan), GitHub App permissions (D-008), the causas-viewer `main` branch, the secret answer key file. **Never bypass a permission denial.** If a classifier or the user blocks something, only the user can decide what happens next.

## Decisions made

- Relies on: D-002, D-007, D-008 (no permission increase anywhere in this plan), D-010 (GLM for testing, Claude only for quality gates), D-011, D-015, D-016, D-018 (Baking required).
- New decisions to append (orchestrator writes them in Spanish in `DECISIONS.md`, see step H2):
  - **D-022**: partial vs exhaustive check coverage. Only `max-lines`/`colocated-test` silence the model, and `check-coverage:` overrides the default. Why: a partial check turned a rule the model covered into a blind spot (v0.7.0 measurement). This partly replaces D-015's "no se le piden de nuevo al modelo".
  - **D-023**: release gate. A behavioural change is not pushed to `master` until the CHANGELOG records its real-model result, unless the user explicitly accepts "unmeasured". Why: v0.7.0 would have shipped a regression.
  - **D-024** (only if the user accepts section 3): Guardrails reviews its own repo through PRs.
  - **D-025** (only if the user accepts section 4): a deterministic "seeded-branches" eval suite comes before the full Phase 0. The R1 go/no-go is deferred until Claude credits are funded. Why: it cuts both subagent tokens and manual measuring.

## Minimal context

- Repo `C:\Users\elabu\Desktop\side-apps\codereview-ai`, app in `guardrails/`. Prod = Vercel, deploys `master` of `github.com/blanck1945/guardrails`.
- **Verified now (read-only):** `origin/master` = `8d756a0`, local `master` = `4f363cb`, **7 commits ahead** (205c6ce B42a, d994724 B42b, b55577b B42c, 3fdb3bf B43, c90a630 B44, 8209002 B45, 4f363cb docs). The orchestrator said 6. It is 6 code commits plus 1 docs commit.
- **Working tree (v0.7.1, uncommitted):** 12 modified files (`review.ts`, `prompt.ts`, `agent/prompts.ts`, `agent/loop.ts`, `checks/{run,spec}.ts`, `config.ts`, `rules/{parse,format,check-field.test}.ts`, `README.md`, `package.json` → `0.7.1`). Untracked: `src/core/checks/partial-coverage.test.ts` and the v0.7.1 handoff. **`CHANGELOG.md` has NO v0.7.1 entry yet.** A commit as-is would break the `guardrails/CLAUDE.md` rule that every version bump comes with a CHANGELOG entry.
- **Key fact for release risk:** causas-viewer `main` has **no `check:` lines** in its rules. The checks exist only in the temp clone (commit `c14f06e "b45: add checks to rules (temp copy only)"`). So in production the partial-check regression is **latent**: it hits only repos whose rules use `forbid-pattern`/`forbid-import`. It also means a prod smoke on causas PRs does **not** exercise the checks path.
- **Existing B45 clone** `C:\Users\elabu\AppData\Local\Temp\causas-viewer-b45`: clean tree, on branch `base45` (= `c14f06e`, rules with the same 4 `check:` lines B45 used), local branches `b45/<name>` for all 6 PRs, remotes `origin/feat/*`. Results of the earlier run are in `...\Temp\b45-results\ledger.json`.
- Webhook triggers: `opened`, `synchronize`, `reopened`, `ready_for_review`, plus `labeled`/`unlabeled` for `guardrails:*` (`src/cloud/app-permissions.ts`). Bots and the App itself are ignored (`isBotEvent`). Skip labels exist. Default cap US$0.25 per review (`src/cloud/review-pr.ts`), overridden by the mode's cap. Webhook `maxDuration: 300`.
- Z.ai endpoint in use: `https://api.z.ai/api/paas/v4` (pay-as-you-go API, not a coding-plan endpoint) (`src/core/models.ts`). Prices in `src/core/pricing.ts`: glm-5.3 US$1.4/4.4/0.26 per M tokens (input/output/cache read); glm-5.3-flash US$0.15/0.5/0.03.
- PR number to branch mapping (CHANGELOG v0.6.0 order): #2 clients-page, #3 upcoming-deadlines, #4 csv-export, **#5 case-reminders**, #6 sort-cases, #7 case-notes-checklist.

## Current state

| Item | State |
|---|---|
| Prod | `8d756a0` (v0.6.0, through B41), healthy |
| v0.6.1 + v0.7.0 | committed, unpushed. Real evidence: 15 local CLI runs, US$0.2753. Label/description mode selection never exercised for real |
| v0.7.1 | in the working tree. `pnpm check` 404 passed / 2 skipped, `pnpm build` green. Real run blocked (clone denied). No CHANGELOG entry |
| Metrics | `.cursor/baking/metrics/runs.jsonl` has 2 lines (both docs-only). About 1.8M subagent tokens not recorded |
| DECISIONS | D-015 and D-016 still "En curso". Nothing records the coverage fix |
| CHANGELOG dates | v0.6.1 and v0.7.0 are dated **2026-09-25**, a day after they were built (cosmetic, fix in the v0.7.1 commit) |

## 1. Immediate blocker: the v0.7.1 real run

**This is the user's decision (a permission). The plan recommends but does not choose.**

| Option | What happens | Risk | Cost |
|---|---|---|---|
| **(1) User allows the clone** | Executor clones `blanck1945/causas-viewer` to `%TEMP%` again, re-adds the 4 `check:` lines, checks out the branches, runs 2 reviews | Re-creating the B45 rules by hand can drift from B45, so results are not comparable. Also more agent steps and tokens. The classifier may prompt again. | Z.ai ≤ US$0.10, about 40–60k subagent tokens |
| **(2) Reuse the B45 clone (recommended)** | Executor runs the CLI in the existing clone: `git checkout b45/case-reminders`, `--mode standard`, then `b45/clients-page`. It never fetches, pushes or edits files there. | The clone could be stale (it was made today at `c14f06e`, and the feature branches have not moved since, so staleness is low). It is still code from an external repo being read, so it needs the user's explicit OK. | Z.ai ≤ US$0.10, about 20–35k tokens |
| **(3) Commit without the run** | CHANGELOG v0.7.1 "What we observed: not measured with a real model (clone denied). Pending" | You ship a fix whose goal (the heading `Recordatorios` is reported again) is unproven. The model may still skip it. This breaks the proposed D-023 gate. | none now, and the measurement debt carries into T2 |

**Recommendation: (2).** It reproduces the exact B45 setup (same rules, same branches), so the before/after comparison is fair, and it is the cheapest. (3) is acceptable only if the user wants the release today and accepts the gap in writing.
**What the user must say:** for (2), for example: "I authorize running the Guardrails CLI read-only in `C:\Users\elabu\AppData\Local\Temp\causas-viewer-b45` (checkout of its local branches allowed; no fetch/push/edit)". For (1): "I authorize cloning my repo blanck1945/causas-viewer into %TEMP%", and approve the prompt if the classifier asks. For (3): "commit v0.7.1 unmeasured". If the tool prompts, the user approves it themselves. Nobody works around a denial.
**Expected results (unchanged from the v0.7.1 handoff):** case-reminders standard: `useReminders.ts:20` reported with origin `check` **and** `ReminderList.tsx` heading `Recordatorios` reported with origin model, rule `english-code-spanish-ui`, with no duplicate of the `:20` check finding. clients-page standard: 0 findings. Report the cost next to the v0.7.0 standard figures (0.0117/0.0071 and 0.0147). If an expectation fails, record it as is and do not tune the cases.

## 2. Release sequence

Rule: **never push `4f363cb` alone.** v0.7.0 contains the latent regression, so it ships only together with v0.7.1.

| # | Step | Who | Cost |
|---|---|---|---|
| R0 | User rotates the Z.ai key and revokes the unused AI Gateway key (see Q3). Put the new key in Vercel env (Production) and in `guardrails/.env.local`. Delete the downloaded `.pem`. Doing this **before** R5 means the new deployment picks up the new key without an extra redeploy. | User | 0 |
| R1 | Permission decision from section 1 | User | 0 |
| R2 | **Resume** the v0.7.1 executor (SendMessage to the same agent, do not start a fresh one). It runs the 2 real runs, writes the CHANGELOG v0.7.1 entry (did / observed with cost delta / next), corrects the v0.6.1/v0.7.0 dates to 2026-09-24, and makes one commit that includes `partial-coverage.test.ts`. No push. | executor (resumed) | about 20–35k tokens, Z.ai ≤ US$0.10 |
| R3 | Verification routine (context handoff §"Verification routine"): clean status, `git log` shows 8 commits ahead, `pnpm check` + `pnpm build` green, secret scan = 0 hits, read the deviations | Orchestrator | 0 |
| R4 | Docs commit: this handoff, the v0.7.1 handoff, `runs.jsonl` back-fill, DECISIONS updates (section 6) | Orchestrator | 0 |
| R5 | Ask the user "push 9 commits to master now?", then `git push origin master`. Vercel deploys. Confirm with the GitHub commit status = success, `GET /api/health` 200, and an unsigned `POST /api/webhooks/github` returning 401. | Orchestrator, after the user says yes | 0 |
| R6 | **Prod smoke.** User adds label `guardrails:deep` to causas-viewer PR #5 in the GitHub UI (create the label if it does not exist). | User | Z.ai about US$0.03–0.05 (cap 0.75) |
| R7 | Read the new review on PR #5 plus the Vercel function log | Orchestrator (read-only `gh pr view 5 --comments`) | 0 |
| R8 | Optional: remove the label. This triggers `unlabeled`, a re-review in the default mode. Default is to **leave the label on** to avoid a second paid review. | User | about US$0.01–0.02 if removed |

**Expected on PR #5 (R7), as pass criteria.** The summary states mode `deep` and why ("label guardrails:deep") and reports 2 passes. Findings include the Spanish comment at `useReminders.ts:20` and the heading `Recordatorios` in `ReminderList.tsx`, both `english-code-spanish-ui`. In prod they come **from the model**, because main has no checks. Findings also include `useReminders.ts:21` `deadline-logic-centralized`. No "model part did not complete" note. Cost is under 0.75. Low-confidence extras (as at `:51` in B45) are acceptable; note them.
**Rollback:** if R5 or R7 fails (error, empty review, timeout above 300 s), the user runs Vercel → Deployments → the `8d756a0` deployment → "Instant Rollback". Then `git revert` plans go through Baking, not ad-hoc edits.
**Not covered by this smoke:** checks in the cloud (no `check:` on causas main) and the description line and `autoMode`. Covering checks needs `check:` lines on causas `main`, which changes the test baseline (Q6).

## 3. Should Guardrails review its own repo?

| | |
|---|---|
| Pros | Real TypeScript code, bigger than causas, so real dogfooding. A PR workflow gives a **natural pre-deploy gate**: Vercel deploys only on merge, which makes D-023 structural. The first reviews of its own code will show false-positive behaviour on a repo with no seeded answers. No permission increase: same App, only one more repo selected. |
| Cons / risks | **Spend:** `synchronize` re-reviews the whole PR on every push, and executor batches are large diffs, so estimate US$0.03–0.10 per review × pushes per PR. **Prompt injection:** `guardrails/eval/cases/**` deliberately contains injection texts and mutated bugs, so a PR touching them can confuse the reviewer. **Self-loop:** low risk. The App's own reviews are not `pull_request` events, and `isBotEvent` ignores the App. **Public repo:** reviews are public, but the code already is. **Workflow change:** agents never push, so every batch needs a branch plus a PR the orchestrator opens with `gh pr create` (a write action, user-approved). |
| Preconditions | T1 released (so it reviews with v0.7.1). A `.guardrails/config.json` in the guardrails repo root with `ignore: ["guardrails/eval/cases/**", "guardrails/eval/candidates/**", "**/*.md"]`, `autoMode` → `basic` for docs-only PRs, and `prOverride` default. A small `rules.md` (3–5 rules from `guardrails/CLAUDE.md`), written by hand or with one `init` (glm-5.3-flash, cap US$0.05). |
| Recommendation | **Yes, but after T1 and together with T2 (cost in summary, model per mode).** Install via GitHub → Settings → Applications → guardrails-boogiepop → Configure → add `blanck1945/guardrails` (user action). Until incremental re-review exists (T4), use the skip label on WIP pushes and let the review run on the final push. Record as D-024. |

## 4. Backlog priority and the next 3 tasks

Order and one-line why:
1. **T1: v0.7.1 release** (sections 1 and 2). It unblocks everything, and prod is 3 versions behind.
2. **T2: seeded-branches eval suite (B14-lite) plus a head-revision fix in `LocalWorkspace`.** Every behavioural change needs re-measuring (context handoff step 6). Today each re-measurement is a long executor run (B45 alone was a large part of the 304k). A single command the orchestrator runs directly removes that cost for good. It also closes part of the Phase 0 gap with deterministic matching (no LLM judge, no Claude credits).
3. **T3: D-020a stateless efficiency wins**: model per mode (`basic` → glm-5.3-flash), cost, mode and model in the PR summary, a path-based skip of the model on trivial diffs (checks still run), and the cache-hit ratio in the review output. It cuts Z.ai spend now, and it is a precondition for self-review.
4. Then **T4: planner-hyper PLAN-DEEP for D-019 + D-020b** (daily spend cap, incremental re-review on push, init on install, where state lives). These all share the "where does state live" decision. Candidate to evaluate: keep the last reviewed SHA in a hidden marker in the review summary (no DB). Blocked on the Z.ai numbers (Q2) and Q4/Q5.
5. Deferred: full Phase 0 (B11 25 real cases, B15 LLM judge, B16 30 labels, B17 baseline plus the R1 go/no-go with Claude). This needs user curation and paid Claude credits. Harder eval cases also need the user (the causas set is near-saturated). Cleanup (dates, D-021 check) rides along in other commits.

| Task | Agent | Acceptance criteria (measurable) | Subagent tokens (est.) | Z.ai cap |
|---|---|---|---|---|
| T1 | executor (**resumed**) + orchestrator | Section 2 R2–R7 pass. `origin/master` = local. Deploy success. PR #5 review matches the expected list. CHANGELOG v0.7.1 has the cost delta. | 20–35k | US$0.10 local + 0.80 prod |
| T2 | executor (Sonnet) from a short handoff the orchestrator writes from this table (no planner: the design is fixed here) | (a) `LocalWorkspace` reads head files via `git show <head>:<path>`, not the working tree, with a unit test where the working tree differs from head. (b) `pnpm eval seeded --clone <dir> --answers <file outside repo> --mode <m> --runs <n> --budget-usd <x>` runs each listed branch against the clone's base. It matches findings to expected problems by file + rule + line window ±3. It prints recall per problem, the finding count on clean branches, cost, time and cache-read ratio, and writes JSONL to `%TEMP%`. (c) Unit tests with a mock model. No test calls a real model. (d) The answers file format is documented. The file itself is never committed. (e) One real run: 6 branches × standard × 1, reproducing the T1 figures within model variance. (f) `pnpm check` + `pnpm build` green, CHANGELOG v0.7.2. | 90–120k | US$0.25 |
| T3 | executor-mecanic for the config/summary parts, or executor if the reviewer prompt order changes | (a) `modes.ts` preset model per mode: `basic` → `zai:glm-5.3-flash`, overridable in config and env. `standard`/`deep` unchanged. (b) The PR summary shows mode, model, cost in USD and tokens (input/cached/output). (c) `skipModelPaths` config (default lockfiles, `*.md`, `docs/**`): if every changed file matches, only checks run and the summary says so. (d) Tests for each. (e) Measure with the T2 command: basic × 6 branches × 2 runs on flash, plus standard × 6 × 1 as a regression check. Record recall and cost vs v0.7.1 in CHANGELOG v0.7.3. | 60–90k | US$0.20 |
| (T4) | planner-hyper | Handoff resolving or deferring: state location, init PR vs issue, obsolete rules, daily cap mechanism, incremental re-review | 100–120k | 0 |

Parallelism: T2 and T3 both touch `review.ts`/summary code, so **run them sequentially**, not in parallel. The user's human tasks (Q2, Q3, B11 curation) run in parallel with any of them.
Total for T1–T3: about 170–245k subagent tokens and at most US$1.35 Z.ai (expected about US$0.40).

## 5. Consumption plan

**Subagent tokens.** History: 12 runs 45k–177k (mean about 117k). The long ones were F1–F3 (151k, 32 min) and B34–B36 (177k).

| Lever | Rule from now on |
|---|---|
| Resume, don't restart | Follow-ups (like v0.7.1's real run) go to the same agent via SendMessage. After a 429 or session limit, check the working tree and resume. |
| Measurement out of agents | After T2, the orchestrator runs `pnpm eval seeded` itself. Executors only build and unit-test. |
| Handoff size | Handoffs of 60 lines or less, with an exact file list, and point to CHANGELOG/DECISIONS **sections** instead of asking the agent to read whole files. |
| Task size | One behaviour per executor run, target 100k or less and 20 min or less. Split anything bigger. |
| No subagent for docs | Metrics, DECISIONS, CHANGELOG fixes and pushes are done by the orchestrator directly. |
| Model choice | planner-hyper only for T4-type design. executor-mecanic for config and plumbing. Forks instead of fresh agents when the context is already loaded. |
| Record every run | Every run appends to `runs.jsonl` with `usage.totalTokens` and duration. Weekly: compare against the 100k target. |

**Z.ai spend, measured truthfully.** The user reads from the Z.ai console (billing/usage pages) and reports:
- (a) spend per day for 2026-09-23 and 2026-09-24;
- (b) tokens per day split into input, cached input and output, **per model** (glm-5.3 vs flash/flashx);
- (c) whether reasoning tokens are shown separately;
- (d) that billing comes from the pay-as-you-go API balance (the code calls `api.z.ai/api/paas/v4`) and not from a subscription plan;
- (e) spend per API key, if the panel breaks it down.

After the R0 rotation, create **two keys, `guardrails-local` and `guardrails-vercel`**, so the panel separates CLI testing from the production webhook.
Comparison: for a day with known runs (the B45 day: 15 runs, our estimate US$0.2753 plus the v0.7.1 runs), take panel spend ÷ our estimate as the calibration factor. If it is above 1.2, T3 adds the factor to `pricing.ts`/the cost summary and D-011 records it. Also compare output tokens (the panel) with reported output tokens (ours). The gap shows the unreported reasoning tokens.

## 6. Process hygiene (orchestrator, directly, in the R4 docs commit; no subagent)

- **H1 `runs.jsonl` back-fill:** one line per row of the DECISIONS appendix (12 runs, 1.40M), plus B42–B45 (304k) and v0.7.1 (81k, outcome `partial: real run blocked by permission`), plus this planner run. Fields: the existing schema with `runtime: "claude-code"`, `profile: "claude"`, `usage.source: "subagent-report-retroactive"`, `usage.totalTokens`, `durationMin`, `ts` = the run date (the day, if the time is unknown), and `review.note: "backfilled 2026-09-24"`. Check: line count = 2 + 15 (+1 for this run), and each line parses as JSON (`node -e` over the file).
- **H2 `DECISIONS.md` (Spanish, keep the format):**
  - D-015 → **Vigente** (v0.6.1), with a note "modificada por D-022".
  - D-016 → **Vigente** (v0.7.0), with a note that the label path is validated by the R6 smoke once done.
  - Add D-022 and D-023. Add D-024/D-025 only after the user answers Q7/Q8.
  - Extend the appendix with B42–B45 and v0.7.1.
  - When: in the R4 commit, before the push, so production and the decision log match.
- Also fix the D-021 weakness noted in DECISIONS (the D-018/D-019 cross-reference slip). Check every "ver D-NNN" by hand in the same edit.

## Files to touch (by later executions, not by this plan)

| File | Action | What |
|---|---|---|
| `guardrails/CHANGELOG.md` | edit (T1 executor) | v0.7.1 entry. Dates of v0.6.1/v0.7.0 → 2026-09-24 |
| `guardrails/src/core/checks/partial-coverage.test.ts` | add to the commit (T1) | already written |
| `.cursor/baking/metrics/runs.jsonl` | append (orchestrator) | H1 back-fill |
| `DECISIONS.md` | edit (orchestrator) | H2 |
| `guardrails/src/core/workspace/*` (LocalWorkspace), `guardrails/eval/cli.ts` + a new `eval/seeded.ts` | T2 | head via `git show`, seeded suite |
| `guardrails/src/core/modes.ts`, `src/core/pricing.ts`, the summary formatter under `src/cloud/`, `src/core/config.ts` | T3 | model per mode, cost in summary, `skipModelPaths` |
| `.guardrails/config.json` + `.guardrails/rules.md` at the guardrails repo root | only if D-024 is accepted | ignore patterns, autoMode basic for docs |

## Implementation steps (strict order)

1. User: answer Q1 (blocker option) and do R0 (key rotation). These are independent and can happen together.
2. T1 per section 2 (R2 → R8).
3. Orchestrator: H1 + H2 inside R4 (before the push).
4. User answers Q7/Q8. The orchestrator writes a ≤60-line handoff for T2 from section 4 and launches the executor.
5. After T2: the orchestrator runs the seeded suite itself for any later change.
6. T3 (handoff ≤60 lines, then executor-mecanic/executor). Measure with T2's command.
7. If D-024 is accepted: the user installs the App on `blanck1945/guardrails`, the config is committed, and T3's PR is the first self-reviewed PR.
8. Once Q2 (Z.ai numbers) is in: T4 planner-hyper.

## Done criteria (checklist)

- [ ] The user's choice for the blocker is recorded in this handoff's Execution section, in their words.
- [ ] CHANGELOG `## v0.7.1` exists with `What we did` / `What we observed` (both real runs with cost, or the explicit "unmeasured" note under option 3) / `Next (v0.7.2)`. `package.json` version = 0.7.1 in the same commit.
- [ ] `git rev-list --count origin/master..master` = 0 after R5. GitHub commit status success. `/api/health` 200. Unsigned webhook POST → 401.
- [ ] PR #5 in causas-viewer has a review whose summary says mode `deep` via the label, and which includes findings at `useReminders.ts:20`, `ReminderList.tsx` (heading), and `useReminders.ts:21`.
- [ ] `runs.jsonl` has 17 or more valid JSON lines (`node -e "require('fs').readFileSync(p,'utf8').trim().split('\n').forEach(JSON.parse)"`).
- [ ] `DECISIONS.md`: D-015/D-016 are Vigente. D-022 and D-023 exist.
- [ ] Z.ai calibration factor (panel ÷ estimate) is recorded in DECISIONS D-011 or the CHANGELOG once the user shares the numbers.
- [ ] Verification mode: prod (R5–R7) + spec (`pnpm check`, `pnpm build`).

## Assets (verify before ship)

| URL / ID | Use | Notes |
|---|---|---|
| `https://guardrails-augusto-pastranas-projects.vercel.app/api/health` | deploy check | expect 200 |
| `github.com/blanck1945/causas-viewer/pull/5` | prod smoke (label `guardrails:deep`) | public repo |
| GitHub App `guardrails-boogiepop` (ID 5061316) | optional install on `blanck1945/guardrails` | no permission change |
| `C:\Users\elabu\AppData\Local\Temp\causas-viewer-b45` | option (2) | read-only use, only if the user authorizes it |

## Risks and edge cases (validate first to kill early)

| Risk | Kill it by |
|---|---|
| v0.7.1 still misses `Recordatorios` (the model ignores the partial-rule hint) | R2 run, the first thing. If it fails, do not push. Re-plan the prompt. |
| Standard gets more expensive (partial rules back in the prompt) | R2 cost delta vs the v0.7.0 table |
| Cloud path differs from local (tarball, labels never exercised, `labeled` webhook) | R6/R7 smoke on PR #5 |
| The key rotation breaks prod (a typo in Vercel env) | R5 health check plus R7 review. Rollback path defined. |
| Cost estimates too low (GLM reports 0 reasoning tokens) | Z.ai calibration factor (section 5) |
| Self-review spend via `synchronize` on large batches | Skip label for WIP, basic for docs, and T3 cost visibility before enabling |
| Injection text in `eval/cases` reaching the reviewer | `ignore` patterns in the guardrails repo config |
| Deep cold start plus 2 passes near the 300 s limit | R7 checks the duration in the Vercel log. B45 local runs took 63 s or less. |
| A subagent killed by the session limit mid-task | Tasks ≤100k tokens, resume instead of restart |

## Out of scope

Code changes in this run. Changing App permissions (`contents: write`) or events. Adding `check:` lines to causas `main`. The LLM judge and the Claude-based R1 decision. DB/queue (B18–B22). Making repos private (user's call).

## Open questions (only the user can answer)

- [ ] **Q1** Blocker: allow a fresh clone (1), reuse the B45 clone read-only (2), or commit unmeasured (3)? → assumed default: **none until you answer** (it is a permission). The plan recommends (2).
- [ ] **Q2** What does the Z.ai panel show for 09-23 and 09-24: spend, tokens per model (input/cached/output), reasoning shown or not, pay-as-you-go balance or plan? → default: assume our estimates are low by an unknown factor and keep all caps as they are.
- [ ] **Q3** Have you rotated the Z.ai key, revoked the AI Gateway key and deleted the `.pem`? → default: not done. R0 happens before the push.
- [ ] **Q4** Where should incremental state live (for T4): a file in the repo, a hidden marker in the PR summary, or a DB later? → default: evaluate the marker first (no DB, no permission).
- [ ] **Q5** Should `init` on install open a PR (`contents: write`) or post the rules as an issue/comment? → default: comment, no permission increase.
- [ ] **Q6** Keep causas-viewer public with PRs #2–#7 open? → default: yes. They are the prod smoke fixtures and hold only fictional code. Closing them later keeps the branches.
- [ ] **Q7** Install the App on `blanck1945/guardrails` and work through PRs (D-024)? → default: yes, after T1 and T3.
- [ ] **Q8** Accept the seeded-suite-first order and defer R1/Phase 0 until you fund Claude credits and curate B11/B16 (D-025)? → default: yes.
- [ ] **Q9** When can you curate the 25 real cases (B11) and label the 30 judge pairs (B16)? → default: not before T3. Phase 0 stays deferred.
- [ ] **Q10** OK to leave the `guardrails:deep` label on PR #5 after the smoke (avoids a second paid review)? → default: leave it.

---

## Execution

_Plan accepted by the user in part._ Q1 was answered "allow"; Q2: prepaid balance; Q5 and Q6 accepted; Q4 left to the default. Steps executed: v0.7.1 was implemented, verified with a real run and released (commit dffc606, deployed with 8ed37e2); the release gate became D-023. Later tasks: v0.7.2 and v0.7.3.

## Quality

Facts about git state, the B45 clone, triggers, prices and endpoints were verified read-only on 2026-09-24. Token and cost figures for T1–T3 are estimates from the DECISIONS appendix and the CHANGELOG v0.7.0 table.
