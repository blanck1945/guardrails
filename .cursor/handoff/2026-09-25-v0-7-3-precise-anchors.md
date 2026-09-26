# Plan: v0.7.3 — anchors that respect the model's evidence ranges

**Handoff:** `.cursor/handoff/2026-09-25-v0-7-3-precise-anchors.md`
**Context:** `guardrails/CHANGELOG.md` v0.7.2 "What we observed" and "Next (v0.7.3)"; `.cursor/handoff/2026-09-25-v0-7-2-dedupe-anchor-summary.md` (what v0.7.2 built); `.cursor/handoff/2026-09-24-guardrails-context.md` (environment and gotchas).

## Objective
Fix the anchor defect found in the v0.7.2 verification: in one of six anchors, a finding about business-day logic in `src/hooks/useReminders.ts` was placed on line 9 (`businessDaysLeft: number;`, an interface field) instead of the function at lines 21-33. Cause: `src/core/findings/anchor.ts` matched a quoted snippet (a fragment of the identifier, at least 8 characters) against the first added line that contains it and ignored the evidence ranges the model gave for the same file (`startLine 21..33` and `20..35`). Also cap the body of merged findings, which can exceed the schema limit of 1500 characters after "Also at line(s) ..." is appended.

## Minimal context
- `src/core/findings/anchor.ts` snaps anchors; `src/core/findings/dedupe.ts` (`mergeAcrossPasses`) merges the two `deep` passes and appends "Also at line(s) N, M."; `src/core/review.ts` snaps each pass before merging; findings follow schema v2 (`src/core/findings/schema.ts`) with `evidence: [{file, startLine, endLine, note}]`.
- Only ADDED, commentable lines may be anchors (existing rule, keep it).

## Decisions made
1. **Ranges first.** For a finding, collect the evidence ranges whose `file` equals the finding's `file`. If there are ranges: a snippet match is accepted only if it falls inside one of those ranges; among matches inside ranges, take the first. If no snippet match falls inside a range, anchor to the first added commentable line inside the best range (the range whose note shares the most words with the title; ties: the first range). If there are no ranges for that file, keep the current behaviour (unique match, else the model's line if it is among the matches, else the first).
2. **Never worse than the model's line.** If the model's own `line` already lies inside one of the ranges and is an added commentable line, and no snippet match inside a range exists, keep the model's line.
3. **Merged findings.** In `mergeAcrossPasses`, when choosing which anchor the merged finding keeps, prefer the candidate whose line lies inside an evidence range of either pass; then the current rule (higher severity, then confidence).
4. **Body cap after merge.** After appending "Also at ...", the body must not exceed the schema limit (1500 characters). If it would, list at most 6 extra locations followed by "and K more.", and only then truncate the original body text (never the "Also at" line) with an ellipsis.
5. No change to presets, thresholds, dedupe matching criteria, the label mechanism or the summary format.

## Files to touch
`src/core/findings/anchor.ts`, `src/core/findings/dedupe.ts`, tests next to them (extend `src/core/findings/merge-anchor.test.ts`), `README.md` (one paragraph), `CHANGELOG.md` (entry v0.7.3 in the fixed format), `package.json` version 0.7.3.
Do NOT edit `DECISIONS.md`, `docs/` or anything under `.cursor/`.

## Implementation steps (strict order)
1. Tests first for the exact failing shape: a file where line 9 is `businessDaysLeft: number;` inside an interface and lines 21-33 hold `function businessDaysBetween(...)`; evidence ranges 21-33 and 20-35; snippet `businessDays` (fragment of an identifier). Expected anchor: inside 21-33 and never 9. Additional cases: snippet match inside the range (kept), several matches with one inside the range (the one inside), no match at all (first added line of the best range), non-added or non-commentable lines never chosen, no ranges (old behaviour unchanged), model line already inside the range (kept), evidence ranges of other files ignored, CRLF and accents normalisation still work.
2. Implement decision 1 and 2 in `anchor.ts`, then decision 3 in `dedupe.ts`.
3. Implement decision 4 with tests: 30 extra locations become 6 plus "and 24 more"; body of 1500+ characters is truncated but keeps the "Also at" line; idempotent.
4. `pnpm check` and `pnpm build` green; README paragraph; CHANGELOG v0.7.3 (What we did / What we observed = "verification pending, script provided" / Next v0.7.4) and version bump.
5. Write the verification script `C:\Users\elabu\AppData\Local\Temp\run-v073-verify.sh` in the same style and with the same safety guard as `run-v072-verify.sh` in that folder (read it first; keep the check that aborts unless the clone's push URL contains DISABLED; work only on the local clone `C:/Users/elabu/AppData/Local/Temp/causas-viewer-v071`, branch `base71`, rebase `v73/*` branches from `origin/feat/*`, forward slashes in the script, outputs to `C:/Users/elabu/AppData/Local/Temp/v073-results`, findings summary printed compactly). Runs, all `--mode deep --budget-usd 0.10 --yes --fail-on none --json`: `feat/case-reminders` three times, `feat/csv-export` once, `feat/clients-page` once. DO NOT run it, DO NOT clone anything, DO NOT call any model: the orchestrator runs it with the user's authorization. If any command is denied, stop and report; never work around a denial.
6. One commit with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, staging only your files with explicit paths (never `git add -A`). No push, no deploy, no secrets printed.

## Done criteria (checklist)
- [ ] The failing shape (interface line 9 vs function 21-33) anchors inside the range in a test, and the old buggy behaviour is covered by a regression test.
- [ ] Evidence ranges of the same file are preferred; the model's line is kept when already inside a range; old behaviour intact when there are no ranges.
- [ ] Merged findings prefer an anchor inside an evidence range.
- [ ] Merged body never exceeds 1500 characters; extra locations capped at 6 plus "and K more".
- [ ] `pnpm check` and `pnpm build` green; CHANGELOG v0.7.3 and version 0.7.3 in the same commit; verification script written and NOT executed.

## Expected results of the later real verification (for the orchestrator; case-reminders lines from the answer key, post-blind)
- `feat/case-reminders` ×3: 3 comments each for 3 problems, no duplicates; Spanish comment anchored at `useReminders.ts:20` (check), business-day finding inside `useReminders.ts` lines 20-33, heading in `ReminderList.tsx` line 11 or 12. Anchors correct in 9 of 9.
- `feat/csv-export`: two problems (component imports the repository directly at `CaseExportButton.tsx` around lines 1-9; `src/domain/csv.ts` without test): 2 comments, no duplicates.
- `feat/clients-page` (clean): no findings.

## Risks and edge cases
- Ranges that the model gets wrong (pointing to unrelated lines): then the anchor follows them. Mitigation: rule 2 keeps the model's own line when it is already inside a range; report any such case in the verification.
- A range that contains no added commentable line: fall back to the model's line, as before.

## Out of scope
New modes or presets, model per mode, incremental re-review, checks in production `rules.md`, `LocalWorkspace` head revision.

## Open questions
None blocking.

## Execution

_Executed._ Commit ac256e3 (v0.7.3). Verification run by the orchestrator (5 deep runs, US$0.144): 9 of 9 anchors correct on case-reminders, csv-export two comments from checks, clean branch with no findings. Released in 68c5ccb.

## Quality
Written by the orchestrator from the v0.7.2 verification results (three real deep runs on the local clone of causas-viewer).
