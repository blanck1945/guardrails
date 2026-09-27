# Plan: v0.8.1 — one problem, one comment also between a check and the model

**Handoff:** `.cursor/handoff/2026-09-27-v0-8-1-check-model-merge.md`
**Context:** `guardrails/CHANGELOG.md` v0.8.0 "What we observed" (production smoke test) and "Next (v0.8.1)"; `DECISIONS.md` D-022 (partial check coverage), D-025 (merge by meaning), D-041; `.cursor/handoff/2026-09-24-guardrails-context.md` (environment and gotchas).

## Objective
Fix the duplicate found in production on PR #9 of `causas-viewer` (v0.8.0, standard mode): the component `RepositoryBadge.tsx` imports `data/repository` (line 1) and calls `createLocalRepository()` (line 5). The `forbid-import` check reported the import at line 1 and the model reported the same layered-data-access violation again at line 5, so the review had 5 comments for 3 seeded problems (plus one low-severity remark). Cause: for a rule with a **partial** check (D-022), a model finding is dropped as a duplicate of a check finding only if it lies within 3 lines of it; 1 and 5 are 4 lines apart. The v0.7.3 review of the same PR had 3 comments, so the model varies between runs and the dedupe rule is what lets the duplicate through.

## Minimal context
- `src/core/review.ts` (integration of check findings and model findings; the dedupe of a model finding against a check finding, "same file and rule; for a partial rule also within 3 lines"), `src/core/checks/run.ts` and `spec.ts` (coverage exhaustive/partial), `src/core/findings/dedupe.ts` (`mergeAcrossPasses` and its "Also at" logic with the validation of v0.7.4: an extra location is listed only if it lies inside an evidence range of the finding's file and is an added line), `src/core/findings/limits.ts`, `src/core/coverage.ts` (counts of findings by origin and the dropped reasons, incl. `duplicate`).
- Findings carry `origin: "check" | "llm"` and `ruleId`; check findings are never dropped and confidence 1.

## Decisions made
1. **Merge check and model by rule and file, whatever the distance.** For a rule that has at least one check finding in file F, any model finding with the same `ruleId` in the same file F is not published as its own comment: it is merged into the check finding of that rule and file that is closest by line, adding its line to that comment's "Also at line N" list. It is counted in coverage as a merged duplicate (reason `duplicate`, or a new `merged-into-check` reason if the coverage types allow it cleanly; list what you chose). Severity, confidence, origin and anchor of the check finding never change (check findings keep confidence 1 and their anchor).
2. **The extra location keeps the validation of v0.7.4?** No: here the extra line comes from the model's finding, so list it only if it is an added, commentable line of that file (no evidence-range requirement), because the model's own anchor is what we merge. Cap of 6 locations and the 1500-character limit stay.
3. **Only merge same-rule, same-file.** A model finding of the same rule in a different file stays its own comment. A model finding with a different rule, or without a rule, is unchanged (the low-severity remark without a rule stays inline; do not change that in this version, because the same-run evidence shows real bugs are sometimes reported at low severity).
4. **Trade-off to document in the README and the CHANGELOG:** if the same rule is violated in two genuinely different ways in one file, the second violation is reduced to an "Also at" line without its own text. The check comment still points at the location.
5. Do not change presets, thresholds, the summary header, the coverage wording, the `deep` low-confidence block or any anchor logic.

## Files to touch
`src/core/review.ts` and/or `src/core/findings/dedupe.ts` (where the dedupe against checks lives), `src/core/coverage.ts` only if a new dropped/merged reason is added, tests next to them (a new test file such as `check-model-merge.test.ts`), `README.md` (one paragraph), `CHANGELOG.md` (entry v0.8.1 in the fixed format), `package.json` version 0.8.1.
Do NOT edit `DECISIONS.md`, `docs/` or anything under `.cursor/`.

## Implementation steps (strict order)
1. Tests first: (a) the exact PR #9 shape: check finding at line 1 (forbid-import), model finding of the same rule at line 5, same file → one published comment for that rule with "Also at line 5"; (b) model finding of the same rule 10 and 40 lines away → still merged; (c) model finding of the same rule in another file → not merged; (d) model finding with another rule or no rule → not merged; (e) exhaustive rule behaviour unchanged (same file and rule already dropped as before); (f) extra line that is not an added commentable line is not listed but the finding is still merged (no orphan comment); (g) the check finding's severity, confidence 1 and anchor never change; (h) the cap of 6 with "and K more" and the 1500-character limit; (i) coverage counts the merge; (j) idempotent. See them fail.
2. Implement decisions 1 to 3.
3. `pnpm check` and `pnpm build` green. No existing assertion should change; list any that must and why.
4. README paragraph; CHANGELOG v0.8.1 (What we did / What we observed = "verification pending, script provided" / Next v0.9.0: records and the report CLI); version 0.8.1.
5. Write the verification script `C:\Users\elabu\AppData\Local\Temp\run-v081-verify.sh` in the style and with the safety guard of `run-v080-verify.sh` in that folder (read it first: abort unless the clone's push URL contains DISABLED; only the local clone `C:/Users/elabu/AppData/Local/Temp/causas-viewer-v071` kept on branch `base71`; head passed with `--head` and never checked out; forward slashes; outputs to `C:/Users/elabu/AppData/Local/Temp/v081-results`; slice JSON from the first `{`). The clone predates PR #8 and PR #9, so the script first runs `git fetch origin main test/checks-violations` (read-only network access to the user's own public repo, allowed for the script) and then reviews `--base origin/main --head origin/test/checks-violations`, three times with `--mode standard --budget-usd 0.10 --details` (the model varies between runs), plus one `--mode standard` on `--head v73/csv-export --base base71` to check no regression. Print for each run the findings with origin and line, the merged "Also at" text, the coverage line and the cost. DO NOT run it, DO NOT clone anything, DO NOT call any model. If any command is denied, stop and report; never work around a denial.
6. One commit with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, staging only your files with explicit paths (never `git add -A`). No push, no deploy, no secrets printed.

## Done criteria (checklist)
- [ ] The PR #9 shape produces one comment for the layered-data-access violation with "Also at line 5"; distance does not matter; other files, other rules and rule-less findings are untouched (tests).
- [ ] Check findings never change severity, confidence or anchor; the cap and the length limit hold.
- [ ] Coverage counts the merge; no existing assertion edited (or each edit justified).
- [ ] `pnpm check` and `pnpm build` green; CHANGELOG v0.8.1 and version 0.8.1 in the same commit; verification script written and NOT executed.

## Expected results of the later real verification (for the orchestrator)
- PR #9 shape, three standard runs: the two check findings plus the Spanish comment (model), no second comment for the layered violation in any run; at most one extra rule-less remark; coverage line intact.
- `v73/csv-export` standard: the same two check findings as in v0.8.0.

## Risks and edge cases
- Over-merging two different violations of one rule (documented trade-off).
- A model finding with no `ruleId` that describes the same violation stays inline (the model may omit the id); note it as a known limit.
- The check finding might sit in a file where the model reports a different anchor file path form; compare normalised paths.

## Out of scope
Records, report CLI, incremental review, moving rule-less low-severity findings, GitLab.

## Open questions
None blocking.

## Execution

_Executed._ Commit 2addb38 (v0.8.1). One existing assertion changed, by design (a model finding of the same partial rule and file, 6 lines from the check, is now merged). Verification run by the orchestrator (4 runs, US$0.029): exactly three comments on the PR #9 shape in three runs; the merge itself was probably not exercised by a real model output.

## Quality
Written by the orchestrator from the production smoke test of v0.8.0 on PR #9.
