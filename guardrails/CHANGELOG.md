# Changelog

Each version has three parts: what we did, what we observed when we measured it, and what that made us do next.
The "Next" of a version is the "What we did" of the following one. Newest first. See `CLAUDE.md` for the convention.

## v0.8.0 — 2026-09-26
### What we did
- Coverage in every review summary (D-027). After the counts line there is one line of at most 220 characters, for example `Coverage: complete · 4 of 5 changed files reviewed (1 ignored) · 5 rules in scope: 2 by checks, 3 by the model (3 with a verdict)`, and at the end a collapsed "What was reviewed" block (at most 8,000 characters) with a files table and a rules table. Two labels are kept apart: **check** (exact result of code for what the check tests) and **model** (the model's claim). Incomplete runs say why in the line (`partial (model ran out of time: checks only)`, `1 of 2 passes failed`, `3 files over the diff budget`, `repo download failed: single-call review`, `no verdict for 2 rules`; two reasons, then `+N more`). Paths that look like secrets are never printed. The renderer is pure and deterministic (`src/core/coverage-render.ts`).
- Cloud wiring: every changed file now has a state (reviewed, ignored by default or config pattern, removed, without a patch, over the diff budget); the single-mode fallback and the number of active rules out of scope are passed in; the summary and the log carry the result. `review.analyzed` gains numbers and codes only: `filesChanged`, `filesReviewed`, `filesIgnored`, `filesRemoved`, `filesNoDiff`, `filesOverBudget`, `filesChecksOnly`, `filesOpened`, `rulesInScope`, `rulesByCheck`, `rulesByModel`, `rulesWithVerdict`, `verdictConflicts`, `coverageComplete`, `coverageReasons`, `lowConfidenceObservations`.
- Config `coverage: "details" | "line" | "off"` (default `details`), read from the base commit like the rest of the config.
- Whole-file diff packing (D-028): the model receives whole files up to the 200,000 character budget (PR order; a file that does not fit is skipped and later smaller files are still tried); nothing is cut mid-file and the excluded files are declared as `over budget`. The mechanical checks and the agent's workspace use the full diff (new optional `ReviewInput.checksDiff`), so a check finding in a file that did not fit is still published. `DiffTooLargeError` and its notice are kept for the failure classification (they are not thrown any more).
- Low-confidence `deep` findings (D-041): a model finding below 0.6 confidence without a rule is no longer posted as an inline comment; it is listed (file and title, at most 5) in the collapsed block, or in its own collapsed block when `coverage` is `line` or `off`. The collection threshold (0.4), checks and rule findings are unchanged.
- CLI: `guardrails review` prints the coverage line and, with `--details`, the block; `--json` already carried `coverage`.
- Tests (mock models only): renderer limits, labels, reasons, secrets, determinism; packing; cloud statuses and over-budget with a check finding still published; fallback visible; config read from base; log fields; the D-041 threshold, cap and untouched rule/check findings; CLI. One existing assertion changed by design (the summary now has a coverage paragraph before the model notes).

### What we observed
Real verification, local CLI with `--details`, `zai:glm-5.3`, temperature 0, `--budget-usd 0.10` per run, on the temporary clone of `causas-viewer` (base branch `base71`, push disabled; the head branches `v73/*` were passed with `--head` and never checked out). Four runs, US$0.080 in total.

| Run | Coverage line | Findings | Cost | Time |
|---|---|---|---|---|
| case-reminders standard | complete, 7 of 7 files, 5 rules: 2 by checks, 3 by the model (3 with a verdict) | 3 (1 check, 2 model) | 0.0166 | 23 s |
| case-reminders deep | same coverage line | 3 (1 check, 2 model) | 0.0377 | 27 s |
| csv-export standard | complete, 5 of 5 files, same split | 2 (both check) | 0.0087 | 17 s |
| clients-page standard (clean) | complete, 8 of 8 files, same split | none | 0.0174 | 26 s |

- **The rule table matched the known truth in all 20 rows** (5 rules by 4 runs): `colocated-tests` and `one-component-per-file` fully by checks, `deadline-logic-centralized` reported by the model in case-reminders and `not applicable` on the clean PR, and `layered-data-access` showing "check: none found (pattern only) · model: ok" where the code was fine and "check: 1 violation · model: violated, not published" on csv-export, where the model agreed with the check and did not repeat it.
- **The labels do their job:** "(pattern only)" appears wherever a partial check found nothing, so a silent partial check is not read as a guarantee. The legend says "check = exact result of code for what the check tests; model = the model's claim; it can be wrong".
- The published findings did not change against v0.7.4 for the same runs (the same three problems in case-reminders, the same two checks in csv-export, none on the clean branch). No low-confidence finding appeared in `deep` this time, so the collapsed block for D-041 was not exercised in a real run (only in unit tests).
- Cost of `standard` on the small PRs stayed in the earlier range (0.009 to 0.017); `deep` on case-reminders cost 0.038. Coverage adds no model calls.
- **What was not verified:** the whole-file packing over the 200,000-character budget and the cloud states of removed, ignored and patch-less files were tested with unit tests only; the real runs were local, where those states are not available (the CLI lists only reviewable files). The behaviour in production (a real PR with the coverage block) is verified after the release.
**Production smoke test of the coverage report (deployed v0.8.0, 2026-09-27).** Label `guardrails:standard` added to PR #9 of `causas-viewer` (the component with three seeded violations). The App posted a new review 23 s after the label, header "mode standard (label guardrails:standard)".
- **The coverage block rendered in production as designed:** "Coverage: complete · 1 of 1 changed file reviewed · 5 rules in scope: 2 by checks, 3 by the model (3 with a verdict)", then the collapsed "What was reviewed" with the files table, the rules table and the check/model legend. The rule rows matched the case: `colocated-tests` 1 violation (check), `layered-data-access` 1 violation (check) and 1 reported by the model, `english-code-spanish-ui` "none found (pattern only)" for the check and 1 reported by the model (the comment has no accents), `deadline-logic-centralized` not applicable, `one-component-per-file` none found.
- **Defect: 5 comments for 3 seeded problems.** The two check findings (missing test at line 1, forbidden import at line 1) and the Spanish comment (model, line 3) are the expected three. The model added a second comment for the same layered-data-access violation, at line 5 (`createLocalRepository()` used in the component), and a low-severity observation (repository read on every render, line 5). The dedupe of a model finding against a check finding of a partial rule only covers findings within 3 lines, and the import (line 1) and its use (line 5) are 4 lines apart. The v0.7.3 review of the same PR had only three comments, so the model's behaviour varies between runs; the dedupe rule is what lets the duplicate through.
- The extra observation (repository read on every render) is a reasonable low-severity remark that is not in the seeded set.
### Next (v0.8.1, before v0.9.0)
- For a rule that already has a check finding in a file, merge any model finding of the same rule and file into that check comment as "Also at line N" instead of publishing a second comment, whatever the distance (extends D-025 from pass-to-pass to check-to-model merges). Test with the PR #9 shape: import at line 1 by the check and its use at line 5 by the model become one comment.
- Decide whether the low-severity model observations without a rule (like "read on every render") should go to the collapsed block in `standard` as they already do in `deep` (D-041), or stay inline.
### Next (v0.9.0)
- Review record v1: a hidden, signed marker at the end of the summary (D-029, D-030) so a review can be counted later.
- `guardrails report`: Markdown and CSV from the records plus live feedback signals (D-031).
- Cost and duration visible by default.

## v0.7.5 — 2026-09-26
### What we did
Part 1 of v0.8.0 (the user-visible v0.8.0 is published after part 2 wires it). Core only: no change in what is published, no new findings, no cloud or CLI wiring.
- `src/core/coverage.ts`: `computeCoverage` builds the coverage object from the data of a review: six file statuses (`removed`, `ignored`, `no-diff`, `over-budget`, `checks-only`, `reviewed`) plus an `opened` flag, per-rule coverage (`check`, `check+model`, `check-failed+model`, `model`; result of the check part and of the model part; whether it counts as covered), the fixed list of ten reasons for an incomplete run, dropped findings by reason and `verdictConflicts`. It holds only paths, rule ids, counters and words. Callers pass what only they know (all changed files with their state, rules out of scope, single-mode fallback) in `ReviewOptions.coverage`.
- Plumbing: `ReviewOutput` now has `coverage`, `checks.exhaustive`, `checks.partial`, `forcedWrapUp` (agent mode; it was dropped before) and `filesOpened`. The agent loop collects the paths it read at head (`read_file`, ref head or omitted, without an error) and `mergeRuns` unions them across the two `deep` passes; single mode reports its full-file contexts as opened.
- Anchor tie-break (from the v0.7.4 observation): when the two passes of `deep` give anchors that both lie inside an evidence range, the one on a line that holds text quoted by the findings (evidence notes, title, body) beats the one that only lies inside a range the model may have got wrong, over severity and confidence. An exact tie of severity and confidence still keeps the earlier candidate. A quote match outside every range never beats a candidate inside a range (that is the v0.7.3 failure). The exact v0.7.4 run 2 shape (line 10 `return (` against the heading on line 12) now anchors on line 12.
- Tests (mock models only): every file status and precedence, every `how`, every model-result branch (with and without a dropped finding, verdict without file, `basic` and single mode), every reason code and their order, determinism, `deep` with two passes and one failed, `forcedWrapUp` propagation, `filesOpened` (head only, no failed reads, deduplicated, union), the anchor tie-break in both pass orders.

### What we observed
Verification pending: part 2 wires the coverage into the cloud and the CLI and measures it on real runs. Nothing changed in published findings; all existing tests pass without edits to their assertions.

### Next (v0.8.0)
- Cloud: keep the state of every changed file (removed, ignored, no patch) and pass it in `ReviewOptions.coverage`; pack whole files into the diff budget instead of cutting the diff (D-028) and run the checks over the full diff.
- Render the visible coverage line and the collapsed details block in the summary (`coverage: details | line | off` in the config), and the same in the CLI (human and JSON).
- Log the coverage numbers in `review.analyzed`.
- Low-confidence `deep` findings in a collapsed block instead of dropping them (D-041).
- Real verification of part 1 and 2 together, including the accuracy of the model verdicts against the answer key.

## v0.7.4 — 2026-09-26
### What we did
- Validated "Also at". When the two `deep` passes are merged, an extra location is listed only if its line lies inside an evidence range of that finding's file (from either pass) and, when the diff is known, is an added line of that file. Otherwise it is omitted; the finding itself is never dropped and the primary anchor rule of v0.7.3 is unchanged. With no surviving location there is no "Also at" text. The cap of 6 extra locations ("and K more") and the 1500-character limit are kept. Two older fixtures without evidence ranges were given ranges.
- Head reads come from the head revision. `LocalWorkspace` now reads head files with `git show <headRef>:<path>`, searches with `git grep <headRef>` (the ref prefix is stripped, so paths are unchanged) and lists files with `git ls-tree`, so `readFile`, `grep`, `findReferencesByName`, `listFiles` and the mechanical checks that read files no longer depend on the checked-out branch or on uncommitted edits. Symlinks of the head tree are rejected, not listed and not searched, as in the tarball workspace; an invalid head revision gives a clear error. Base reads are unchanged. `init` keeps reading the working tree through the explicit `workingTree: true` option, because it documents the checkout as it is on disk.
- Dry-run estimate from the real diff. `profileFromDiff(diffChars, fileCount, mode)` sizes one run as 3k tokens of fixed overhead plus the diff (4 characters per token) read again 3 times in `standard` and 6 in `deep`, with output growing with the number of files; the CLI dry-run uses it, and the fixed profile remains only as a fallback where no diff exists. The constants live in one place (`DIFF_ESTIMATE`) with the measured runs they come from.
- Tests (mock models and temporary git repos only): the exact v0.7.3 run 2 shape (line 10 omitted, line 12 kept), an extra line inside a range that is not an added line, no surviving location, the cap of 6; head reads with another branch checked out and an uncommitted edit, committed symlink, invalid head revision, working-tree mode; monotonic estimate, `deep` above `standard`, a 3-file 120-line diff within 3 times of the measured costs, and the CLI dry-run using it.

### What we observed
Real verification, local CLI, `zai:glm-5.3`, temperature 0, `--budget-usd 0.10` per run, on the temporary clone of `causas-viewer` (base branch `base71`; push disabled). **The clone stayed on `base71` during all runs: the head branches (`v73/*`) were passed with `--head` and never checked out**, which is the direct test of the head-revision reads. Three runs.

| Run | Findings (file:line, origin) | Dry-run estimate | Real cost | Ratio | Time |
|---|---|---|---|---|---|
| case-reminders deep 1 | useReminders.ts:20 (check); useReminders.ts:21 (model); ReminderList.tsx:12 (model) | 0.0554 | 0.0346 | 1.60 | 29 s |
| case-reminders deep 2 | useReminders.ts:20 (check); useReminders.ts:21 (model); ReminderList.tsx:10 (model, "Also at line 12") | 0.0554 | 0.0299 | 1.85 | 33 s |
| csv-export standard | CaseExportButton.tsx:1 layered-data-access (check); csv.ts:1 colocated-tests (check) | 0.0151 | 0.0097 | 1.56 | 22 s |

- **Head reads work without a checkout:** all three runs gave the expected findings while the clone was on `base71`, including `csv.ts` without a colocated test, which needs the head file list.
- **The dry-run estimate is now within 1.6 to 1.9 times of the real cost** (it was about 10 times too high in v0.7.1 to v0.7.3), always above the real cost. Total real spend of this verification: US$0.074.
- **"Also at" validation held:** the only extra location listed (line 12 in run 2) is the actual heading. No misleading extra locations. Three comments for three problems in both `deep` runs; the two check findings of csv-export are at the expected places.
- **One anchor was off by two lines.** In run 2 the heading finding was anchored on line 10 (`return (`), and the real heading is on line 12 (it appears in "Also at"). The model gave two evidence ranges for that finding: a wrong one (lines 9 to 11) and a right one (line 12). Both passes' anchors lay inside some range, so the merge kept the one from the pass with the higher severity and confidence. Anchors in this verification: 5 of 6 as expected in the two deep runs on case-reminders (the miss is this one) and 2 of 2 in csv-export.
- Cost of `deep` on case-reminders was US$0.030 to 0.035 this time against 0.022 to 0.025 in v0.7.3; three or five runs each, so no trend is claimed.
### Next (v0.8.0)
- Coverage in the summary: which files and rules the review actually looked at.
- Diff budget by whole files instead of truncating the diff.
- Low-confidence `deep` findings in a collapsed block instead of dropping them or lowering the floor (D-041).
- Record cost and duration of production reviews per mode from the Vercel logs.

## v0.7.3 — 2026-09-25
### What we did
- Anchors respect the model's evidence ranges. For a finding, the ranges of its own file come first: a quoted snippet moves the anchor only when the match falls inside one of them (the model's line if it is one of those matches, otherwise the first). With no match inside a range, the model's line is kept when it is an added, commentable line inside a range; otherwise the anchor goes to the first added line of the best range (the one whose note shares the most words with the title; ties: the first). Ranges without any added commentable line are ignored, and without usable ranges the v0.7.2 behaviour is unchanged. This fixes the interface line (`businessDaysLeft: number;`, line 9) chosen over the function at lines 21 to 33.
- Merged findings prefer an anchor inside an evidence range (of either pass) over higher severity or confidence; those remain the tie-break.
- The merged body never exceeds the schema limit of 1500 characters: at most 6 extra locations are listed ("Also at lines 1, 2, 3, 4, 5, 6 and 24 more."), and only then the original text is truncated with an ellipsis (never the "Also at" line). Idempotent.
- Tests (mock models only): the exact failing shape (line 9 interface field against a function at 21 to 33 with ranges 21-33 and 20-35), snippet inside the range, several matches, no match, tied ranges, model line inside a range, non-added lines, no ranges, ranges of other files, CRLF and accents, merge preference, 30 extra locations, over-long body. Three older fixtures whose evidence ranges did not match their own line were corrected.

### What we observed
Real verification, local CLI, `zai:glm-5.3`, temperature 0, `--mode deep`, `--budget-usd 0.10` per run, on the temporary clone of `causas-viewer` (base branch `base71` = `origin/main` plus the four `check:` lines; push disabled). Five runs.

| Run | Findings (file:line, origin) | Merged | Dropped | Cost | Time |
|---|---|---|---|---|---|
| case-reminders 1 | useReminders.ts:20 (check); useReminders.ts:21 (model); ReminderList.tsx:12 (model) | 2 | 0 | 0.0238 | 34 s |
| case-reminders 2 | useReminders.ts:20 (check); useReminders.ts:20 (model, "Also at line 21"); ReminderList.tsx:12 (model, "Also at line 10") | 2 | 1 duplicate of the check finding | 0.0219 | 37 s |
| case-reminders 3 | useReminders.ts:20 (check); useReminders.ts:21 (model, "Also at line 22"); ReminderList.tsx:11 (model, "Also at line 12") | 2 | 0 | 0.0246 | 39 s |
| csv-export | CaseExportButton.tsx:1 layered-data-access (check); csv.ts:1 colocated-tests (check); CaseExportButton.tsx:9 (model, low, 0.6); csv.ts:18 (model, low, 0.4) | 0 | 0 | 0.0396 | n/a |
| clients-page (clean) | none | 0 | 0 | 0.0337 | n/a |

- **Anchor defect fixed: 9 of 9 anchors correct on case-reminders.** The Spanish comment at line 20 in all runs (check), the business-day logic inside the function (lines 20 to 22, all within 20 to 33; in v0.7.2 one run had it on line 9, an interface field), and the heading at line 11 or 12. No duplicates: 3 comments for 3 problems in each run, with 2 merges per run.
- **The dedupe against checks worked:** in run 2 a model finding about the same Spanish comment (line 19, conf 0.97) was dropped as a duplicate of the check finding.
- **csv-export:** both seeded problems reported by the checks, at the expected places (the import at line 1, `csv.ts` without a test). Two extra low-confidence model findings ("export ignores the active case filters", "serializes the raw English status enum while headers are Spanish") that are not in the answer key; not judged. They are the kind of extras `deep` already produced in v0.7.0.
- **Clean branch:** no findings.
- Cost of `deep`: US$0.022 to 0.025 per review on case-reminders, US$0.034 on the clean branch and US$0.040 on csv-export; total US$0.144 for the five runs. Lower than the v0.7.2 runs on the same PR (0.029 to 0.043); three runs each, so no trend is claimed.
- The merged heading finding in run 2 lists "Also at line 10", a location that is not the heading. The merged extra locations come from the second pass and are not validated against the evidence; the primary anchors are.
**Production smoke test of the mechanical checks (deployed v0.7.3, 2026-09-26).** PR #8 of `causas-viewer` added `check:` lines to four rules (accent pattern, colocated test, forbidden repository import, 150 lines) and was merged after the App reviewed it ("No issues found", with the note that the base-branch rules were used). PR #9 then added `src/components/RepositoryBadge.tsx` that imports `data/repository`, has no test and a Spanish comment.
- The App posted 3 comments in 36 s (PR opened 16:23:51 UTC, review 16:24:27 UTC), CI green. Summary: "3 findings: 2 from checks, 1 from the model".
- From the checks: `layered-data-access` at line 1 (forbidden import) and `colocated-tests` at line 1 (no `RepositoryBadge.test.*`). From the model: the Spanish comment at line 3. The model did not repeat the two findings the checks had already reported.
- **The Spanish comment came from the model, not from the accent check, because the test comment had no accented characters** ("Muestra la cantidad de causas cargadas."). My expectation that the accent check would fire was wrong; the case shows the partial-coverage design of v0.7.1 working: the check cannot see unaccented Spanish and the model still catches it.
- Anchors on the right lines (1, 1 and 3); no duplicates. The rule change itself (PR #8) was not flagged.
### Next (v0.7.4)
- Validate the extra locations listed in "Also at" against the evidence ranges (the heading finding of run 2 listed line 10, which is not the heading).
- Read cost and duration of production reviews from the Vercel logs and record them per mode.
- Make `LocalWorkspace` read head files from the head revision (`git show`) instead of the working tree.
- Judge the extra low-confidence findings of `deep` and, if they are noise, raise its confidence floor or require evidence lines.

## v0.7.2 — 2026-09-25
### What we did
- One problem, one comment. In `deep`, findings of the two passes are merged by meaning instead of by line distance: same file and same rule (or, without a rule, a similar title) is the same problem. Matching is one to one across passes, so two different problems under one rule that both passes report stay two, and findings of the same pass are never merged. The merged finding keeps the higher severity (ties: higher confidence), gets +0.1 confidence for being seen twice, unites the evidence and lists the other locations in its body ("Also at lines 25, 31."). The count of merged duplicates is returned (`merged`).
- Precise anchors. Each finding is moved to the added line that contains the code it quotes (backtick or quoted text in the evidence notes, the title or the body; at least 8 characters; whitespace, CRLF and accents normalised). Several matches keep the model's line if it is one of them, otherwise the first; no match keeps the model's line. Only added, commentable lines are chosen. Snapping runs before the passes are merged, so both passes usually land on the same line.
- Structured summary, produced by code: first line `**Guardrails** · mode <mode> (<source>)`, then `N findings: A from checks, B from the model` (plus merged duplicates), then at most two lines of the model's notes. Failure and cap notices are kept.
- Cost visibility. `review.analyzed` now logs passes, passes failed, input/output/cached tokens, steps, costUsd (null without a price), ms and merged. New optional footer on the PR summary, `Cost ~US$0.02 · 38 s · 2 passes`, only with `GUARDRAILS_SHOW_STATS=1` (default off).
- Tests use mock models only (merge shapes including the PR #5 case, idempotence, anchor cases, summary text, stats footer, log fields, one end-to-end deep case). The summary header format changed, so the four mode assertions of the cloud tests were updated.

### What we observed
Real verification, local CLI, `zai:glm-5.3`, temperature 0, `--mode deep`, `--budget-usd 0.10` per run, on the temporary clone of `causas-viewer` (base branch `base71` = `origin/main` plus the four `check:` lines; push disabled). Three runs: `feat/case-reminders` twice, `feat/clients-page` once.

| Run | Findings (file:line, rule, origin) | Merged | Cost | Time | Steps |
|---|---|---|---|---|---|
| case-reminders 1 | useReminders.ts:20 english-code-spanish-ui (check); ReminderList.tsx:12 english-code-spanish-ui (model); useReminders.ts:21 deadline-logic-centralized (model) | 2 | 0.0426 | 39 s | 6 |
| case-reminders 2 | useReminders.ts:20 (check); useReminders.ts:9 deadline-logic-centralized (model, "Also at line 21"); ReminderList.tsx:12 english-code-spanish-ui (model) | 2 | 0.0289 | 38 s | 5 |
| clients-page (clean) | none | 0 | 0.0364 | 34 s | 8 |

- **Goal met: one problem, one comment.** Both `deep` runs on the seeded branch produced 3 comments for the 3 problems (in production v0.7.1 the same PR got 6). The pass merge fired twice per run. No `dropped` findings, no extra low-confidence findings this time, and the clean branch has no findings.
- **Anchors: 5 of 6 correct, one wrong.** Correct: the Spanish comment at line 20 (check) and the heading at line 12 in both runs, and the business-day logic at line 21 in run 1 (inside the function, lines 20 to 33). Wrong: in run 2 the merged business-day finding kept line 9, which is `businessDaysLeft: number;` in the interface. Cause: the snapper matched a quoted snippet (a fragment of the identifier `businessDays...`) against the first added line that contains it, and ignored the evidence ranges the model itself gave for that file (lines 21 to 33 and 20 to 35). The comment is still on the right file and explains the problem, but a reviewer would see it on an unrelated line.
- Cost of `deep` on this small PR: US$0.029 to 0.043 (US$0.036 on the clean branch), 34 to 39 s, inside the estimate of US$0.03 to 0.05. Three runs are too few to give a range.
- The "Also at line N" text is appended to the body after the schema limit of 1500 characters was applied, so a merged body can exceed it.
- Merge is decided without the model, so it is only as good as the rule ids and titles the passes produce; a finding without a rule and with a very different title in each pass will still appear twice.
### Next (v0.7.3)
- Fix the anchor defect: prefer the evidence ranges of the finding's own file. Snap to a snippet match only when it falls inside one of those ranges (or, without ranges, when it is the only match); otherwise use the first added line of the best evidence range. Add a test with the interface-line case of run 2.
- Re-apply the body length limit after merging (or cap the "Also at" list).
- Repeat the case-reminders `deep` run several times to see how often the anchor and the merge hold.
- Read cost and duration of production reviews from the Vercel logs (`review.analyzed`, now with tokens and passes) and record them per mode.
- Make `LocalWorkspace` read head files from the head revision (`git show`) instead of the working tree.
- Judge the extra low-confidence findings of `deep` (are they noise?) and, if so, raise its confidence floor or require them to cite evidence lines.

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

**Production smoke test of v0.7.0/v0.7.1 (deployed commit `8ed37e2`), 2026-09-24.** Label `guardrails:deep` added to PR #5 of `causas-viewer` (feat/case-reminders), which had one review from the v0.6.0 deployment. The production `rules.md` has no `check:` lines, so this run exercised the modes and the label trigger, not the mechanical checks.
- The `labeled` action re-triggered the review: a second review from the App appeared 50 s after the label (23:37:49 to 23:38:39 UTC). The summary states the mode and its source ("Review mode: deep (label guardrails:deep)").
- All three seeded problems of that PR were found, all by the model: business days reimplemented in the hook, the Spanish comment in the hook, and the hardcoded heading `Recordatorios` in the component.
- **Defect: 6 inline comments for 3 problems.** The business-day finding appears twice (`useReminders.ts:19` and `:26`) and so does the Spanish comment (`:18` and `:25`). Deep runs two passes and unites their findings; the dedupe window is 3 lines, and the two passes anchored the same problem 7 lines apart, so both were published. The real lines are around 20 and 21, so the anchors of both passes are also imprecise.
- One extra low finding (`useReminders.ts:40`, `today` fallback recomputed per render) that is not in the answer key; it looks like a real minor smell, not judged.
- The summary is the model's free notes ("No other issues: tests are colocated...; Checked repository/domain modules..."), which reads like internal reasoning rather than a summary.
- Cost and duration of the deep review were not read from the Vercel logs (`review.analyzed`); the 50 s is the label-to-review latency seen from GitHub.

### Next (v0.7.2)
- Dedupe across the two `deep` passes by file, rule and title similarity regardless of line distance, and merge them into one comment that lists both locations, so one problem produces one comment.
- Snap each finding's anchor to the added line that contains the quoted text (validate the line against the diff) instead of trusting the model's line number.
- Give the review summary a fixed structure (mode and source, counts by origin, then at most two lines of notes) instead of the model's free notes.
- Read cost and duration of production reviews from the Vercel logs (`review.analyzed`) and record them, per mode.
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
