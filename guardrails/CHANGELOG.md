# Changelog

Each version has three parts: what we did, what we observed when we measured it, and what that made us do next.
The "Next" of a version is the "What we did" of the following one. Newest first. See `CLAUDE.md` for the convention.

## v0.7.1 — 2026-09-25
### What we did
- Fix for the loss found in the v0.7.0 measurement: a partial mechanical check no longer silences the model. Checks now have a coverage. `exhaustive` (default for `max-lines`, `colocated-test`) fully decides the rule, so the model is told to skip it, as before. `partial` (default for `forbid-import`, `forbid-pattern`) only catches a subset of violations, so the rule stays in the model prompt (single and agent) and in the per-rule verdict pass, together with the locations the check already reported ("do not repeat these, but still look for violations the check cannot see").
- Dedupe: a model finding that repeats a check finding is still dropped. For an exhaustive rule the match is the same file and rule (unchanged); for a partial rule it must also be within 3 lines of a check finding, so a finding elsewhere in the same file is kept.
- Optional `check-coverage: exhaustive | partial` in the rule header of `rules.md` overrides the default of the check kind (for example to declare a `forbid-pattern` exhaustive when it really decides the rule and save model spend). Parse and serialize round-trip is stable; an invalid value is reported and dropped, the rule is kept.
- `runChecks` now returns `exhaustive` and `partial` (with reported locations) next to `ran`. Tests use mock models only (defaults per kind, override both ways, prompts of both engines, kept and dropped findings, round-trip). README documents the coverage table.

### What we observed
Real verification, one run per branch (local CLI, `zai:glm-5.3`, temperature 0, `--mode standard`, `--budget-usd 0.05`). Setup as in v0.7.0: a temporary clone of `blanck1945/causas-viewer` (never pushed), base branch = `origin/main` plus the same four `check:` lines, each feature branch rebased onto it and checked out.

| Branch | Findings (file:line, rule, origin) | Cost | Time | Steps |
|---|---|---|---|---|
| case-reminders | useReminders.ts:20 english-code-spanish-ui (check); ReminderList.tsx:11 english-code-spanish-ui (model, conf 0.95, "Hardcoded Spanish UI heading Recordatorios"); useReminders.ts:21 deadline-logic-centralized (model, conf 0.95) | 0.0181 | 28 s | 2 |
| clients-page (clean) | none | 0.0109 | 19 s | 2 |

- Both expectations met: the accented comment comes from the check, the unaccented heading `Recordatorios` that v0.7.0 missed in every mode is reported again (by the model), and the clean branch has no findings. 0 findings dropped in both runs.
- Cost against the v0.7.0 standard runs: case-reminders 0.0181 against 0.0117 and 0.0071; clients-page 0.0109 against 0.0147. The partial rule is back in the model prompt, which explains the higher case-reminders cost; clients-page was slightly cheaper. Two runs are too few to call a trend. Total real spend of this verification: about US$0.029.
- The pre-run estimate printed by the CLI (about US$0.17 per run) overstates the real cost roughly 10 times for this small PR, because it assumes the PLAN section 9 profile of 273k input tokens.
- One run per branch: whether the heading is found on every run was not measured.

### Next (v0.7.2)
- Make `LocalWorkspace` read head files from the head revision (`git show`) instead of the working tree.
- Judge the extra low-confidence findings of `deep` (are they noise?) and, if so, raise its confidence floor or require them to cite evidence lines.
- Make the CLI dry-run estimate use the size of the actual diff instead of the fixed PLAN section 9 profile.
- Repeat the case-reminders run a few times per mode to see how stable the model finding on the unaccented heading is.

## v0.7.0 — 2026-09-25
### What we did
- B43: three review modes per PR, presets in `src/core/modes.ts`: `basic` (4 steps, US$0.05, confidence 0.8, cap 3, no per-rule verdicts), `standard` (12 steps, US$0.25, confidence 0.6, cap 5, verdicts asked; it keeps following `config.strictness`), `deep` (24 steps, US$0.75, confidence 0.4, cap 12, verdicts required, 2 passes). Mechanical checks run in every mode and are never capped.
- `deep` runs two independent agent passes concurrently under the same deadline (the second one with a "rules first, then logic bugs" focus so the passes are not copies at temperature 0); findings are united, deduplicated (same file, lines within 3, same rule or similar title) and a finding seen by both gets +0.1 confidence. If one pass fails or the time runs out, the other pass plus the checks are published and the summary says so.
- Mode selection, highest priority first: `guardrails review --mode`; PR label `guardrails:<mode>` (case-insensitive, strictest wins); `guardrails-mode: <mode>` line in the PR description; `autoMode` in the base `config.json` (`filesGreaterThan`, `filesLessThan`, `linesChangedGreaterThan`, `onlyPaths`, `touchesPaths`; conditions of an entry are ANDed, first entry wins); config `mode`; `standard`. `prOverride: "none"` makes labels and description powerless (documented risk: with the default `"labels"` a PR author can relax their own review).
- Webhook: `labeled`/`unlabeled` re-review only for labels starting with `guardrails:`; no new event or permission. The review summary states the mode and why.
- Decisions taken where the request was ambiguous: `standard` keeps following `config.strictness` for confidence and cap (so existing repos see no change), while `basic` and `deep` fix their own; `--mode agent|single` (old meaning) is still accepted and `--engine agent|single` was added, because `--mode` now names the review mode; the CLI now applies the mode's spend cap when `--budget-usd` is not given; `GUARDRAILS_REVIEW_BUDGET_USD`, when set, replaces the mode's cap; `GUARDRAILS_REVIEW_TIMEOUT_SEC` (default 240) is an upper bound, `basic` asks for 120 s; a pass that times out loses its partial work (the agent only reports at the end).

### What we observed
Re-measurement of v0.6.1 + v0.7.0 on the PRs of `blanck1945/causas-viewer` (local CLI, `zai:glm-5.3`, temperature 0, review with `--mode`, `--budget-usd` on every run). The rules of `main` were copied to a temporary clone (never pushed) and given checks there: `english-code-spanish-ui` = `forbid-pattern: [áéíóúÁÉÍÓÚñÑ¿¡]` (exclude `src/i18n/**`, tests), `colocated-tests` = `colocated-test`, `layered-data-access` = `forbid-import: data/repository`, `one-component-per-file` = `max-lines: 150`. Real total cost: US$0.2753 for 15 runs (cap was US$0.40); the requested runs cost US$0.2151 and the optional `feat/case-notes-checklist` runs US$0.0602. Mode was chosen with `--mode`, so the label/description path was not exercised here.

| Branch | Mode | Findings (file:line, rule, origin) | Cost | Time | Steps |
|---|---|---|---|---|---|
| clients-page (clean) | basic | none | 0.0100 | 17 s | 2 |
| clients-page (clean) | standard | none | 0.0147 | 34 s | 3 |
| upcoming-deadlines (clean) | basic | none | 0.0088 | 13 s | 2 |
| upcoming-deadlines (clean) | standard | none | 0.0107 | 22 s | 2 |
| csv-export | standard r1 | CaseExportButton.tsx:1 layered-data-access (check); csv.ts:1 colocated-tests (check) | 0.0103 | 30 s | 3 |
| csv-export | standard r2 | identical to r1 | 0.0036 | 16 s | 2 |
| csv-export | deep | the same 2 checks, plus 4 low-confidence model findings without rule (CaseExportButton.tsx:8 and :9 export ignores active filters, csv.ts:3 no formula-injection protection, csv.ts:16 raw status enum), confidence 0.5 to 0.55 | 0.0459 | 63 s | 8 (2 passes) |
| case-reminders | standard r1 | useReminders.ts:20 english-code-spanish-ui (check); useReminders.ts:21 deadline-logic-centralized (model, conf 0.95) | 0.0117 | 32 s | 2 |
| case-reminders | standard r2 | same two (model conf 1.0) | 0.0071 | 22 s | 2 |
| case-reminders | deep | the same two, plus useReminders.ts:51 deadline-logic-centralized (low, 0.7, "0 business days left" on a weekend deadline) | 0.0313 | 39 s | 5 (2 passes) |
| sort-cases | standard r1 | useCases.ts:36 comparator puts cases without a deadline first (model, medium, 0.8) | 0.0173 | 53 s | 4 |
| sort-cases | standard r2 | same problem at :35 (low, 0.7) | 0.0124 | 59 s | 3 |
| sort-cases | deep | useCases.ts:35 same comparator problem (low, 0.6) and useCases.ts:35 deadline-logic-centralized (high, 0.8); a third duplicate was dropped | 0.0313 | 46 s | 6 (2 passes) |
| case-notes-checklist (extra) | standard | CaseWorkspace.tsx:151 one-component-per-file: file has 156 lines (check) | 0.0160 | 29 s | 1 |
| case-notes-checklist (extra) | deep | same check finding | 0.0442 | 38 s | 4 (2 passes) |

- Success criteria: 0 findings on the two clean branches in all 4 runs (basic and standard) (met); the Spanish comment at `useReminders.ts:20` is detected in standard (2 of 2 runs) and deep, always with origin `check` (met); check findings are identical between the two runs of the same mode on every branch (met, same file, line, rule and text); the comparator bug of `feat/sort-cases` is detected in deep (met; also in both standard runs, with a different line, severity and confidence each time: 36/medium/0.8 vs 35/low/0.7).
- Variation between runs of the same mode: check findings none; model findings kept the same problem but varied in line, severity and confidence (see above). Only 2 runs per cell, so this is a small sample.
- A loss found by the measurement: the seeded unaccented Spanish label `<h2>Recordatorios</h2>` in `ReminderList.tsx` (the one v0.6.0 found) is no longer reported in any mode. The accent regex cannot see it, and because the rule has a check the model is told the rule is verified mechanically and skips it (the deep notes even say the heading "is an i18n inconsistency" but not reportable). A partial check turns a rule the model used to cover into a blind spot.
- `deep` costs about 3 to 4 times `standard` per PR (US$0.031 to 0.046 against 0.004 to 0.017) and takes 39 to 63 s with the two passes concurrently (well inside 240 s). On these PRs it added the comparator's second finding and 5 low-confidence extra model findings (4 on csv-export, 1 on case-reminders) that were not among the seeded problems; whether they are useful was not judged. The per-rule verdicts were returned (`ruleChecks`) and no report was bounced or marked `incomplete-rule-checks` in these runs.
- `temperature: 0` was accepted by Z.ai on all 15 runs. No run hit a budget, timeout or rate limit.
- Found while measuring: `LocalWorkspace` reads head files from the working tree, not from the head revision, so the CLI must have the head branch checked out for `max-lines`, `colocated-test` and `forbid-pattern(only)` (and for the model's `read_file`) to see the right content. The runs above checked out each branch first. This is an old limitation, not new in this version.

### Next (v0.7.1)
- Partial checks: let a rule declare that its check is only a proxy (for example `check-mode: hint`), so the model still verifies it and only the check's findings are deduplicated against the model's (fixes the lost unaccented label).
- Make `LocalWorkspace` read head files from the head revision (`git show`) instead of the working tree.
- Judge the extra low-confidence findings of `deep` (are they noise?) and, if so, raise its confidence floor or require them to cite evidence lines.
- More runs per cell to measure model variation with more than 2 samples.
- Efficiency ideas (not implemented yet): a model per mode (for example glm-5.3-flash for `basic`); incremental re-review on push (only what changed since the last reviewed commit); less context per call and prompt-prefix ordering so the provider cache hits; skip trivial diffs (lockfiles, formatting, docs only); a daily spend cap; cost visibility per review (cost and mode in the PR summary, aggregated over time).

## v0.6.1 — 2026-09-25
### What we did
- B42a: mechanical checks per rule, no model. `rules.md` accepts `check:` and `exclude:`; `src/core/checks/` runs `max-lines: N`, `colocated-test`, `forbid-import: <glob|substring>` and `forbid-pattern[(comments|code|strings)]: <regex>` over the parsed diff and the head tree (`Workspace`). Findings carry `origin: "check"`, confidence 1, the rule's severity and type, and an exact `file:line`.
- `reviewDiff` runs the checks first and independently of the model. Check findings skip the confidence/type filters and the strictness cap. Rules whose check ran are listed to the model as "verified mechanically, do not report"; model findings that repeat a check (same file and rule) are dropped as duplicates. If the model fails, runs out of budget or time, the check findings are still published and the summary says the model part did not complete. The summary states how many findings came from checks.
- `guardrails init` asks the model for a `check:` when a rule allows it and validates its syntax; an invalid check is discarded with a warning and the rule is kept without it.
- B42b: `temperature: 0` by default on every review and init call, decided in one place (`src/core/sampling.ts`), with a `GUARDRAILS_TEMPERATURE` override and a per-mode preference (v0.7.0). A fixed `seed` is sent only to providers that document one: the Z.ai chat-completion reference lists no `seed` (checked 2026-09-24), so none is sent to it unless `GUARDRAILS_SEED` is set. The LLM cache key already hashes every call parameter, so temperature and seed are part of it (tested).
- B42c: `report_findings` accepts `ruleChecks: [{ruleId, file?, verdict: violated|ok|not-applicable, note?}]`. The agent prompt asks for one verdict per active rule without a `check:` and per changed file in scope, and to list EVERY location of a violation (grep/read over added lines, comments and identifiers included), not only the first. With `ruleChecks: "require"` (used by `deep` in v0.7.0) the loop bounces a report that misses rules once; after that it accepts what there is and adds `incomplete-rule-checks` to the notes. A report bounced and never repeated (steps exhausted) is still used.
- Decisions taken where the request was ambiguous: an invalid `check:` in `rules.md` is reported as a rule error and dropped (the rule stays active without it); `forbid-pattern(only)` works on TS/JS/TSX/JSX files only (regex literals are not lexed, JSX text counts as code) and is skipped elsewhere; file-level findings (`max-lines`, `colocated-test`) are anchored to an added line so GitHub can place the inline comment; in the cloud single-mode fallback there is no workspace, so `max-lines`, `colocated-test` and `forbid-pattern(only)` are skipped and those rules go to the model as usual.

### What we observed
- Not measured on its own: v0.6.1 and v0.7.0 were built back to back, and the first real measurement of both is the re-measurement recorded under v0.7.0.
- Unit level: the check types are deterministic (same diff and tree, same findings; tested by running with the rule order reversed).

### Next (v0.7.0)
- Review modes per PR (`basic`, `standard`, `deep`) with presets, selection by CLI, label, PR description and `autoMode` in config, and the `prOverride` guard (B43), done in v0.7.0.
- Re-measure the seeded PRs with both changes (B45), recorded under v0.7.0.

## v0.6.0 — 2026-09-24
### What we did
- B41: the cloud webhook reviews with the agent over tarballs of base and head (no git, no sandbox): `TarballWorkspace` with size and path-safety limits and a JS grep with a ReDoS guard, budget and one 240 s deadline per review, fallback to single mode when the tarball cannot be obtained, temp files disposed in `finally`. Opt-in cloud smoke test (`pnpm smoke:cloud`) with a fake GitHub HTTP server, the real Octokit and the real model. An empty review summary is never posted.

### What we observed
- Measured on the deployed webhook (agent over tarball, `zai:glm-5.3`) on 6 seeded PRs of a test app (`blanck1945/causas-viewer`, PRs #2 to #7: `feat/clients-page`, `feat/upcoming-deadlines`, `feat/csv-export`, `feat/case-reminders`, `feat/sort-cases`, `feat/case-notes-checklist`; `main` carries `.guardrails/rules.md` with 5 active rules: `english-code-spanish-ui`, `colocated-tests`, `layered-data-access`, `deadline-logic-centralized`, `one-component-per-file`).
- 6 of 7 seeded problems were found, 0 false positives, 2 PRs came out clean with no noise, and the logic bug (a comparator that puts cases without a deadline first) was detected.
- The miss: a Spanish comment inside `src/hooks/useReminders.ts` (rule `english-code-spanish-ui`). The model reported only the other location of the same rule (a Spanish label in `ReminderList.tsx`) and stopped after 2 steps. Reproduced locally with `dropped` empty: the model omitted it, the filter did not drop it.
- The code did not set `temperature`, so runs of the same PR vary.

### Next (v0.6.1)
- Rules that can be checked by a program should not depend on the model: mechanical checks (B42a).
- Fix the sampling: `temperature: 0` (B42b).
- Force an exhaustive per-rule pass and all locations of a violation (B42c).

## v0.5.1 — 2026-09-24
### What we did
- B40a: absence claims must be grounded (prompt policy plus a deterministic `contradicted-by-repo` check against the head tree).
- B40b: less noise per change: at most 2 findings per line, rule findings first, a cap by strictness (3/5/8) with high-severity rules exempt, focus prompts.
- B40c: rules carry a finding type (`type:` in `rules.md`, schema, `init` generates it); a finding that cites an active rule takes the rule's type.
- F1/F2/F3 fixes done before it: findings that cite an active rule bypass the comment-type filter; Z.ai json mode no longer strips `json` from paths; init validates and repairs rule scopes against tracked files; faster init (parallel source groups, rule and output caps, low reasoning effort on Z.ai, timeout, per-stage progress).

### What we observed
- With `zai:glm-5.3` the agent described both bugs of the smoke case but 0 findings survived: it attached made-up `ruleId`s and the filter discarded the whole finding (fixed in v0.4.0's follow-up, commit 58afa30).
- Z.ai `response_format: json_object` deletes the token `json` from the output (`seeds.config.json` became `seeds.config.`), which corrupted generated file names (commit ee29795).
- On a 4-file repo, 9000 output tokens of `glm-5` were 100% reasoning and produced no answer, which set the 16000-token init cap.

### Next (v0.6.0)
- Run the agent in the cloud webhook, where the real PRs are (B41).

## v0.5.0 — 2026-09-24
### What we did
- B34: `guardrails review` (local git range, base commit config) and `hook install|uninstall` (pre-push, non-blocking on infrastructure failures); a review is aborted after 5 minutes.
- B35: GitHub App manifest and setup guide; hardened webhook (202 answer, in-memory dedupe of deliveries, triggers for drafts/forks/skip labels, bot filter, size cap, failure notices, structured logs) and `/api/health`.
- B36: Vercel config and deploy guide, complete `.env.example`, `next build` type-checks.

### What we observed
- The webhook still reviewed in one shot over the diff plus up to 15 complete files (no tools), the limit recorded in PLAN-DETAILED §0.2, while the local CLI already ran the agent.
- Dedupe of deliveries is per server instance (a redelivery on a cold instance is not dropped); a durable table stays in the backlog (B19).

### Next (v0.5.1)
- Reduce noise and ground claims (B40), and give the cloud the agent (B41, done in v0.6.0).

## v0.4.0 — 2026-09-24
### What we did
- B33a: model resolver (`zai:<id>`, `deepseek:<id>`, AI Gateway ids) and pricing table.
- B33b: spend control (`CostTracker`, `--budget-usd`, `--dry-run`, `--yes`, `costUsd`).
- B33c: disk cache of model responses (dev and eval only, `GUARDRAILS_LLM_CACHE=1`).
- B33d: `pnpm guardrails smoke`, one real-model pass capped at US$0.05.
- Filter by comment type, rule scopes, findings that cite an unknown `ruleId` keep the finding and strip the id, `glm-5.3` prices, faster `init`.

### What we observed
- Real-model smoke on `zai:glm-5.3`: 0 findings survived because of made-up `ruleId`s (see v0.5.1).
- Estimates come from a per-run profile (agent: 273k input tokens, 4.7k output, 75% cached), not from measured runs yet.

### Next (v0.5.0)
- Make it usable where developers work: local review, pre-push hook, GitHub App, deploy (B34 to B36).

## v0.3.0 — 2026-09-23
### What we did
- B06: `Workspace` interface and `LocalWorkspace` (git through argv, limits, path-escape checks).
- B07: agent loop (`generateText` with tools and a terminal `report_findings`), step and token budget with forced wrap-up, one-shot elision of old tool results, retry and salvage of invalid reports; `reviewDiff` mode `single|agent`.
- B08: findings schema v2, fingerprint, dedupe, sanitize. B30 to B32: `.guardrails/rules.md` (parser, serializer, merge), `guardrails init` (collector, LLM synthesizer, redundancy filter, non-destructive merge), review against rules from the base commit.

### What we observed
- Nothing measured with a real model yet at this point; the agent was covered by mock-model tests only.

### Next (v0.4.0)
- Real providers, spend control and cache before running it for real (B33).

## v0.2.0 — 2026-09-23
### What we did
- Evaluation set: `eval/` case schema and loader (B09), SZZ miner (B10: 36 candidates from hono, fastapi and trpc), injected-bug miner (B12: 10-mutation catalog and 15 injected cases, 6 of them cross-file), clean-case miner (B13: 20 clean cases) and 3 hand-written prompt-injection cases.

### What we observed
- All mined cases are `validated: false` until they are checked by hand; no baseline run had been made.

### Next (v0.3.0)
- The agent and its `Workspace`, and team rules in `rules.md` (B06 to B08, B30 to B32).

## v0.1.0 — 2026-09-23
### What we did
- Core and MVP of the webhook: single-shot review of a PR diff with structured output, config from `.guardrails/config.json`, ignore patterns (`isIgnored`, B04), `parseUnifiedDiff` (B05), `safeParseConfig` (B03), vitest set-up.

### What we observed
- PLAN-DETAILED §0.2 (read from the code): the webhook is not durable and has no idempotency; it read `.guardrails/config.json` from the head, so a PR could weaken its own review; the diff was cut at 200k characters mid-file; the context was the first 15 files without priority; an invalid config threw and the review died silently.

### Next (v0.2.0)
- Measure before building more: an evaluation set.
