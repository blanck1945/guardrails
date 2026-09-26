# Plan: v0.7.4 — validated "Also at", head reads from the head revision, diff-sized dry-run estimate

**Handoff:** `.cursor/handoff/2026-09-26-v0-7-4-alsoat-headreads-estimate.md`
**Context:** step 1 of `.cursor/handoff/2026-09-26-roadmap-v0-8-plan.md`; `guardrails/CHANGELOG.md` v0.7.3 "What we observed" and "Next (v0.7.4)"; `DECISIONS.md` D-025, D-026, D-041; `.cursor/handoff/2026-09-24-guardrails-context.md` (environment and gotchas).

## Objective
Three small fixes found in the v0.7.2 and v0.7.3 verifications. No new features.
1. **"Also at" validation.** In run 2 of the v0.7.3 verification the merged heading finding listed "Also at line 10", which is not the heading. Extra locations added when the two `deep` passes are merged come from the second pass and are not validated against the evidence.
2. **Head reads from the head revision.** `LocalWorkspace` reads head files from the working tree, so the CLI only gives right results when the head branch is checked out (workspace `readFile`, `grep`, `findReferencesByName`, `listFiles`, and therefore the mechanical checks that read files such as `max-lines` and `colocated-test`).
3. **Dry-run estimate from the real diff.** The CLI dry-run uses a fixed profile of 273k input tokens and overstates the cost about 10 times for small PRs.

## Minimal context
- `src/core/findings/dedupe.ts` (`mergeAcrossPasses`, the `also` list, anchor rule from v0.7.3: evidence ranges of the finding's own file first; findings have `evidence: [{file, startLine, endLine, note}]`).
- `src/core/workspace/local.ts` (`readFile` head at about lines 113-118, `grep`, `findReferencesByName`, `listFiles`, `diff`), `src/core/workspace/contract.ts` (shared suite run for `LocalWorkspace` and `TarballWorkspace`), `src/core/workspace/local.test.ts`.
- `src/core/spend.ts` (fixed profile at about line 17: 12k/1.5k single, 273k/4.7k agent), `src/cli/review.ts` (dry-run at about line 283), `src/cli/guardrails.ts` (init dry-run).
- Measured real costs to calibrate against (CHANGELOG): `standard` on a small PR US$0.004 to 0.018; `deep` US$0.022 to 0.043; the fixed profile printed about US$0.17 per run.

## Decisions made
1. **"Also at" only lists lines that pass a validation.** A merged finding lists another location only if that line lies inside an evidence range of that finding's file (from either pass) AND is an added, commentable line of that file. Otherwise the location is omitted. The finding itself is never dropped and the primary anchor rule of v0.7.3 is unchanged. If no extra location survives, no "Also at" text is added. Keep the cap of 6 and the 1500-character limit.
2. **Head reads come from the head revision, not the working tree.** `LocalWorkspace` reads head content with `git show <headRef>:<path>` and searches with `git grep ... <headRef> --` (all through the existing argv-only `execFile` helpers, same path-escape rules and limits), so results do not depend on which branch is checked out or on uncommitted changes. `headRef` defaults to `HEAD` as today. `listFiles` for head uses `git ls-tree` on the head revision. Keep base reads as they are. Symlinks in the head tree: skip them, as the tarball workspace does.
3. **Estimate from the diff.** Add `profileFromDiff(diffChars, fileCount, mode)` to `spend.ts`: input tokens = fixed prompt overhead (rules and system prompt, assume 3k) + diff chars / 4 + a per-step context growth term for agent modes (assume 3 steps of re-reading for `standard`, 6 for `deep`), output tokens = a small function of the number of files. Keep the calibration constants in one place with comments citing the measured runs. Use it in the CLI dry-run when a diff is available; keep the fixed profile only as a fallback when there is no diff (for example `init` before collecting). Acceptance: for a 3-file, 120-line diff the estimate lies within 3 times of the measured standard costs above (US$0.004 to 0.018), and for `deep` within 3 times of US$0.022 to 0.043.
4. Do NOT change presets, thresholds, the `deep` confidence floor (D-041 moves low-confidence findings to a collapsed section in v0.8.0), the label mechanism or the summary format.

## Files to touch
`src/core/findings/dedupe.ts` (+ tests in `merge-anchor.test.ts` or a new test file), `src/core/workspace/local.ts` (+ `local.test.ts` and the shared `contract.ts` if a contract case is needed for both implementations), `src/core/spend.ts`, `src/cli/review.ts`, `README.md`, `CHANGELOG.md` (entry v0.7.4 in the fixed format), `package.json` version 0.7.4.
Do NOT edit `DECISIONS.md`, `docs/` or anything under `.cursor/`.

## Implementation steps (strict order)
1. Tests first for the "Also at" cases: the exact shape of v0.7.3 run 2 (extra line 10 outside every evidence range is omitted; line 12 inside a range and added is kept); an extra line inside a range but not an added line is omitted; no surviving extra lines means no "Also at" text; the primary finding is never dropped; the cap of 6 and "and K more" still hold. Then implement decision 1.
2. Tests first for head reads on a temporary git repo: working tree differs from the head revision (another branch checked out, and an uncommitted edit) and `readFile`, `grep`, `findReferencesByName` and `listFiles` return head content; path escape and symlink cases unchanged; the shared contract suite stays green for both implementations. Then implement decision 2.
3. Tests first for `profileFromDiff` (monotonic in diff size, `deep` above `standard`, the 3-file 120-line case within the bounds) and for the CLI dry-run using it. Then implement decision 3.
4. `pnpm check` and `pnpm build` green; README paragraph for each of the three changes; CHANGELOG v0.7.4 (What we did / What we observed = "verification pending, script provided" / Next v0.8.0: coverage in the summary, diff budget by whole files, low-confidence `deep` findings in a collapsed block) and version 0.7.4.
5. Write the verification script `C:\Users\elabu\AppData\Local\Temp\run-v074-verify.sh`, same style and safety guard as `run-v073-verify.sh` in that folder (read it first; abort unless the clone's push URL contains DISABLED; work only on the local clone `C:/Users/elabu/AppData/Local/Temp/causas-viewer-v071`; forward slashes; outputs to `C:/Users/elabu/AppData/Local/Temp/v074-results`; slice the JSON from the first `{`). It must prove decision 2: keep the clone checked out on `base71` while reviewing, passing the head explicitly (for example `--base base71 --head v73/case-reminders`), and never check the head branch out. Runs: `--mode deep --budget-usd 0.10` twice on `v73/case-reminders`, and `--mode standard --budget-usd 0.10` once on `v73/csv-export`. For each run print the dry-run estimate (from `--dry-run` first, no model call) and the real cost so the ratio is visible. DO NOT run it, DO NOT clone anything, DO NOT call any model: the orchestrator runs it with the user's authorization. If any command is denied, stop and report; never work around a denial.
6. One commit with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, staging only your files with explicit paths (never `git add -A`). No push, no deploy, no secrets printed.

## Done criteria (checklist)
- [ ] An "Also at" location outside the evidence ranges, or not an added line, is omitted; the finding is never dropped (tests).
- [ ] `LocalWorkspace` head reads (`readFile`, `grep`, `findReferencesByName`, `listFiles`) return the head revision regardless of the checked-out branch or uncommitted changes (tests, both workspaces still pass the contract suite).
- [ ] `profileFromDiff` exists; the 3-file 120-line estimate is within 3 times of the measured costs; the CLI dry-run uses it.
- [ ] `pnpm check` and `pnpm build` green; CHANGELOG v0.7.4 and version 0.7.4 in the same commit; verification script written and NOT executed.

## Expected results of the later real verification (for the orchestrator)
- With `base71` checked out (head not checked out): `v73/case-reminders` deep, twice: 3 comments for 3 problems, every "Also at" line is the same problem (or absent), anchors as in v0.7.3, check findings identical to v0.7.3.
- `v73/csv-export` standard: 2 findings from checks at the expected places.
- Dry-run estimate vs real cost ratio at most 3 in every run.

## Risks and edge cases
- `git grep <ref>` prefixes results with the ref name; strip it so paths stay identical to today.
- Head reads for a `headRef` that is not a commit-ish (invalid): keep the existing clear error.
- The estimate constants are calibrated on a few runs; state this in the comments and the README.

## Out of scope
Coverage report, diff budget by whole files, collapsed low-confidence findings, records, GitLab.

## Open questions
None blocking.

## Execution

_Executed._ Commit 4535841 (v0.7.4), released in bc1cd2e. Verification run by the orchestrator (3 runs, US$0.074, head branches never checked out): estimate within 1.6 to 1.9 times of the real cost; one anchor two lines above (fixed in v0.7.5).

## Quality
Written by the orchestrator from step 1 of the roadmap plan and the v0.7.3 verification results.
