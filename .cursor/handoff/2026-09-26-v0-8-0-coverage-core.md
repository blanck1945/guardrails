# Plan: v0.8.0 (part 1 of 2) — coverage: core computation and anchor tie-break

**Handoff:** `.cursor/handoff/2026-09-26-v0-8-0-coverage-core.md`
**Source of truth for the design:** `.cursor/handoff/2026-09-26-roadmap-v0-8-plan.md` sections **A.1 Metric definitions, A.2 Where each datum comes from, A.3 Exact PR summary format, A.4 Tests and acceptance** (read them completely first; do not re-derive or change the definitions; where this handoff and the plan differ, this handoff wins and the difference is listed under "Decisions made"). Also read `DECISIONS.md` D-027, D-028, D-041, `guardrails/CHANGELOG.md` (v0.7.4 "What we observed" and "Next (v0.8.0)"), `guardrails/CLAUDE.md` and `.cursor/handoff/2026-09-24-guardrails-context.md` (environment and gotchas).

## Objective
Build the **core** of the coverage report so that, after part 2 wires it to the cloud and the CLI, every review can say what was actually examined, with mechanical guarantees ("check") and model claims ("model") kept apart. This part is pure computation and plumbing inside `src/core`: no change in what is published, no change in findings, no cloud or CLI wiring, no new permission.

## Scope of this part
1. **`src/core/coverage.ts` (new)** with a pure function that builds the coverage object of A.1 from a review's data (the six file statuses plus the "opened by the agent" flag, the per-rule coverage with how it was checked / what the result was / when it counts as covered, and the fixed list of reasons for marking a run incomplete). Follow A.1 and A.2 exactly for field names, statuses and counting rules.
2. **Data plumbing (A.2):** expose what already exists but is dropped or hidden: `ruleChecks` from the report, `forcedWrapUp` from the agent loop (currently dropped), check `ran/skipped/exhaustive/partial`, passes and passes failed, dropped findings with reasons, `incomplete`/`modelIncomplete`, files opened by the agent (tool call log) if A.2 says so. Add a `coverage` field to `ReviewOutput` (`src/core/review.ts`), computed for `single` and `agent` modes and for `deep` with two passes (merge the per-pass data as A.2 says).
3. **Rendering data, not text:** produce the structured data the summary will need. Do NOT render or publish the summary line or the details block yet (that is part 2, formats in A.3); you may add the pure text renderer to `src/core/summary.ts` only if it is fully unit tested and unused by the cloud in this part. Prefer to leave rendering to part 2.
4. **Anchor tie-break (from the v0.7.4 observation):** when several anchor candidates lie inside evidence ranges, prefer the candidate that matches a quoted snippet of the finding over one that only lies inside a range the model may have got wrong. In `src/core/findings/anchor.ts` and in the choice inside `mergeAcrossPasses` (`dedupe.ts`). Regression test with the exact v0.7.4 run-2 shape: file lines 9 to 12 where line 10 is `return (` and line 12 is `<h2>Recordatorios</h2>`; evidence ranges 9..11 and 12..12; passes anchored at 10 (higher severity) and 12; the merged finding must anchor on 12 and "Also at" must not list a line that is the primary anchor.

## Decisions made
1. Follow A.1 to A.4 of the plan for every definition. The `coverage` config option (`details | line | off`) and the summary text are part 2; here only the data.
2. The core stays independent of GitHub (D-002): no Octokit, no provider names in `src/core/coverage.ts`.
3. Coverage never changes findings, costs or published output in this part. All existing tests must pass **without editing any assertion**; only add fixtures/fields where new required fields force it, and list each such edit in the report.
4. D-041 (low-confidence `deep` findings into a collapsed block) is part 2 because it changes what is published.

## Files to touch
`src/core/coverage.ts` (new) + `src/core/coverage.test.ts`, `src/core/review.ts`, `src/core/agent/loop.ts` (+ `passes.ts` if needed), `src/core/findings/anchor.ts`, `src/core/findings/dedupe.ts` (+ tests in `merge-anchor.test.ts`), `src/core/index.ts` (exports), `README.md` (a short section "Coverage data (core)"), `CHANGELOG.md` (entry **v0.8.0-part1 is NOT a version**: add the entry as `v0.7.5` with the usual three sections, since the user-visible v0.8.0 is published after part 2; "What we observed" = "verification pending: part 2 wires and measures it", "Next (v0.8.0)" = part 2 items), `package.json` version 0.7.5.
Do NOT edit `DECISIONS.md`, `docs/`, or anything under `.cursor/`. Do NOT touch `src/cloud/*` except for type compile fixes if a new required field forces them (list them).

## Implementation steps (strict order)
1. Read A.1 to A.4. Write the tests of A.4 that belong to the core first (per-file statuses, per-rule coverage for mechanical and model rules, incomplete reasons, `deep` with two passes and one failed pass, single mode, `forcedWrapUp` propagation), and the anchor tie-break regression test. See them fail.
2. Implement `coverage.ts`, the plumbing, and the tie-break until green.
3. Verify "no change in published findings": run the whole existing suite; confirm zero assertion edits.
4. `pnpm check` and `pnpm build` green; README and CHANGELOG v0.7.5; one commit with the trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, staging only your files with explicit paths (never `git add -A`). No push, no deploy, no secrets printed. No real-model runs, no clones: the real verification is part 2's job (V2) and is run by the orchestrator.
5. If any command is denied, stop and report; never work around a denial.

## Done criteria (checklist)
- [ ] `computeCoverage` (or the name the plan uses) returns the A.1 structure for single, agent and deep (two passes, one failed) cases; every A.4 core test passes.
- [ ] `ReviewOutput.coverage` exists; `ruleChecks` and `forcedWrapUp` reach it.
- [ ] Anchor tie-break: the v0.7.4 run-2 shape anchors on line 12; no "Also at" repeats the primary anchor.
- [ ] Zero edited assertions in existing tests (list any fixture edits); nothing changes in published findings.
- [ ] `pnpm check` and `pnpm build` green; CHANGELOG v0.7.5 and version 0.7.5 in the same commit.

## Risks and edge cases
- Files that disappear silently today in the cloud selection (removed, ignored, binary or too large) are only visible in `review-pr.ts`; part 1 must define the input type so part 2 can pass them in, without wiring it yet.
- The coverage object must be small and free of code content (D-030 applies later to records): only paths, rule ids, counters and status words.

## Out of scope
Cloud and CLI wiring, summary text and details block, config `coverage`, whole-file diff packing (D-028), collapsed low-confidence findings (D-041), records, GitLab.

## Open questions
None blocking. If A.1 to A.4 contradict each other on a detail, choose the simpler reading and list it under deviations.

## Execution

_Executed._ Commit 9acd49d (v0.7.5): coverage data in the core and the anchor tie-break; 30 new tests, no existing assertion edited.

## Quality
Written by the orchestrator from step 3 of the roadmap plan and the v0.7.4 verification.
