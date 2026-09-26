# Plan: v0.8.0 (part 2 of 2) — coverage in the review summary, whole-file diff packing, collapsed low-confidence findings

**Handoff:** `.cursor/handoff/2026-09-26-v0-8-0-coverage-wiring.md`
**Design source:** `.cursor/handoff/2026-09-26-roadmap-v0-8-plan.md` sections **A.3 Exact PR summary format** and **A.4 Tests and acceptance (v0.8.0)** (cloud, CLI and log parts), plus the "Decisions made" rows 1, 2 and 3. Part 1 is done and committed (`9acd49d`, v0.7.5: `src/core/coverage.ts` with `computeCoverage`, `ReviewOutput.coverage`, `ReviewOptions.coverage` context, anchor tie-break). Read `.cursor/handoff/2026-09-26-v0-8-0-coverage-core.md` and your own part 1 report for what exists. Also `DECISIONS.md` D-027, D-028, D-041; `guardrails/CHANGELOG.md`; `guardrails/CLAUDE.md`.

## Objective
Make every review say what was examined. Publish a one-line coverage summary plus a collapsed details block in the PR comment, keep the honest split between "check" (exact result of code) and "model" (claim), stop cutting the diff silently, and move low-confidence `deep` findings out of inline comments into the collapsed block. This is the user-visible v0.8.0.

## Scope
1. **Summary rendering (A.3).** A pure renderer in `src/core/summary.ts` (or a new module) that turns the `coverage` object into the visible line (at most 220 characters) and the collapsed `<details>` block (at most 8,000 characters, as A.3/A.4 say), with the two labels **check** and **model** and the wording for incomplete runs from A.3. The existing structured header and counts of v0.7.2 stay; the coverage line goes where A.3 says. Unit tests of the renderer (length limits, labels, incomplete reasons, `deep` with a failed pass, single mode, empty PR).
2. **Cloud wiring (`src/cloud/review-pr.ts`).** Pass `CoverageContext` (all changed files with their state: reviewed, ignored by pattern, removed, without patch/binary, over budget, failed to read; `rulesOutOfScope`; `fallback`) into `reviewDiff`, publish the rendered coverage in the summary body. Files that disappear silently today in the file selection (removed, ignored, patch-less) must be reported with their state. Log fields in `review.analyzed`: the coverage counters and reason codes only (no paths, no code). Config option `coverage: "details" | "line" | "off"` (default `details`) read from the **base** commit like the rest of the config (schema in `src/core/config.ts`, safe parse with defaults, README).
3. **Whole-file diff packing (D-028).** Replace `fullDiff.slice(0, MAX_DIFF_CHARS)` in `review-pr.ts` by packing **whole files** into the model's diff budget (200,000 characters, keep the constant): files that do not fit are marked `over-budget` and declared in the coverage; the **mechanical checks keep running over the full diff** (as they get `fullDiff` today). Never cut a file in the middle. Order files so small ones fit first or by the order of the PR, whichever the plan says; if it says nothing, keep the PR order and pack until the budget is reached. Remove or reuse the dead `DiffTooLargeError` path consistently (list what you did). Tests: a PR over the budget declares the excluded files, the checks still report a violation in a file that did not fit, nothing is cut mid-file.
4. **Low-confidence `deep` findings (D-041).** In `deep`, a model finding with confidence below 0.6 and no rule is not published as an inline comment: it goes to a short list inside the collapsed block ("lower-confidence observations", file and title only, cap of 5). The collection threshold of `deep` stays 0.4; checks and rule findings are never moved. Tests for the threshold, the cap and that rule/check findings are untouched.
5. **CLI (`src/cli/review.ts`).** Human output prints the coverage line and, with a flag (for example `--details`), the details block; `--json` already carries `coverage`. Tests.
6. **Docs and version.** README section on the coverage report (what it means, what "check" and "model" mean, the honest caveat that coverage measures what was looked at, not whether it was looked at correctly, config `coverage`), CHANGELOG **v0.8.0** with the usual three sections ("What we observed" = verification pending, script provided; "Next" = records and report v0.9.0), `package.json` 0.8.0.

## Decisions made
- The cloud fallback to `single` (tarball failure) must be visible in the coverage (A.3 wording); coverage counts it as a reason for an incomplete run.
- No new App permission, no new event, no database (D-008, D-036). Do not change the summary header of v0.7.2 beyond inserting the coverage line.
- Findings, costs and dedupe behave as in v0.7.5 except the two intended changes: whole-file packing and the collapsed low-confidence findings.

## Files to touch
`src/core/summary.ts` (+ tests), `src/core/config.ts`, `src/cloud/review-pr.ts` (+ `review-pr.test.ts`, `modes-cloud.test.ts` only if a header assertion must follow the new line; list every assertion edit), `src/cloud/log.ts` only if fields are missing, `src/cli/review.ts` (+ test), `README.md`, `CHANGELOG.md`, `package.json`.
Do NOT edit `DECISIONS.md`, `docs/` or anything under `.cursor/`.

## Implementation steps (strict order)
1. Tests first: renderer limits and labels; packing (over budget, checks over the full diff); collapsed low-confidence; config default; CLI output. See them fail.
2. Implement the renderer, the packing and the collapsed block; then the cloud and CLI wiring; then the config.
3. `pnpm check` and `pnpm build` green. Existing assertions should not change except where the summary structure changes by design; list each one.
4. Write the verification script `C:\Users\elabu\AppData\Local\Temp\run-v080-verify.sh` in the style and with the safety guard of `run-v074-verify.sh` (read it first: abort unless the clone's push URL contains DISABLED; only the local clone `C:/Users/elabu/AppData/Local/Temp/causas-viewer-v071` on branch `base71`; head passed with `--head v73/<branch>` and never checked out; forward slashes; outputs to `C:/Users/elabu/AppData/Local/Temp/v080-results`; slice the JSON from the first `{`). Runs, all with `--budget-usd 0.10` and the coverage details printed: `--mode standard` on `v73/case-reminders`, `--mode deep` on `v73/case-reminders`, `--mode standard` on `v73/csv-export`, and `--mode standard` on `v73/clients-page`. DO NOT run it, DO NOT clone anything, DO NOT call any model. If any command is denied, stop and report; never work around a denial.
5. One commit with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, staging only your files with explicit paths (never `git add -A`). No push, no deploy, no secrets printed.

## Done criteria (checklist)
- [ ] The visible coverage line is at most 220 characters and the details block at most 8,000; both labelled check/model; incomplete runs say why.
- [ ] Removed, ignored and patch-less files are reported with their state; the fallback to single mode is visible.
- [ ] No file is ever cut in the middle; excluded files are declared; checks still run over the full diff (tests).
- [ ] `deep` findings below 0.6 without a rule appear only in the collapsed block (cap 5); rule and check findings are never moved.
- [ ] `coverage` config (`details | line | off`) read from the base commit; log fields carry counters only.
- [ ] `pnpm check` and `pnpm build` green; CHANGELOG v0.8.0 and version 0.8.0 in the same commit; the verification script exists and is not executed.

## Expected results of the later real verification (for the orchestrator)
- `v73/case-reminders` standard and deep: the coverage line states 7 files reviewed, 5 rules in scope with their split (mechanical vs model), no incomplete reason; the details block lists each rule with `check` or `model`. In `deep`, per-rule verdicts labelled as model claims.
- `v73/csv-export` standard: the two check results appear under `check`.
- `v73/clients-page` (clean): coverage line present, no findings.
- No published finding differs from v0.7.5 for the same runs apart from low-confidence `deep` ones moved to the block.

## Risks and edge cases
- The 220-character line must degrade gracefully with many reasons (truncate with a "+N more").
- Rendering must be deterministic (fixed order of reasons and rules) so a re-review does not produce spurious diffs.
- Do not print paths of ignored secrets files in the details.

## Out of scope
Records and signed markers (v0.9.0), report CLI, incremental review, efficiency items, GitLab, database.

## Open questions
None blocking. If A.3 leaves a wording open, choose the simplest and list it under deviations.

## Execution

_Executed._ Commit de2de9d (v0.8.0): coverage line and details in the summary, whole-file diff packing, collapsed low-confidence deep findings, `coverage` config, CLI `--details`. One existing assertion changed by design. Verification run by the orchestrator (4 runs, US$0.080): the rule table matched the known truth in 20 of 20 rows.

## Quality
Written by the orchestrator from step 4 of the roadmap plan, the decisions D-027, D-028 and D-041, and the part 1 report.
