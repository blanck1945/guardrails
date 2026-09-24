# Plan: v0.7.1 — a partial mechanical check must not silence the model

**Handoff:** `.cursor/handoff/2026-09-24-v0-7-1-partial-check-coverage.md`
**Context:** `.cursor/handoff/2026-09-24-guardrails-context.md`, `DECISIONS.md` (D-015), `guardrails/CHANGELOG.md` (v0.7.0 "What we observed").

## Objective
Fix a regression introduced in v0.6.1/v0.7.0 and found by the B45 re-measurement: in `feat/case-reminders` of the test repo, `ReminderList.tsx:11-12` contains the unaccented Spanish heading `<h2>Recordatorios</h2>`. v0.6.0 (model only) reported it. Now no mode reports it, because rule `english-code-spanish-ui` has a `forbid-pattern` check (accented characters) that cannot see it, and rules with a check are declared to the model as "verified mechanically, do not report".

## Minimal context
- Checks live in `guardrails/src/core/checks/` and are integrated in `guardrails/src/core/review.ts`; the prompt text that tells the model to skip rules is in `src/core/prompt.ts` and `src/core/agent/prompts.ts`.
- The check kinds are `max-lines`, `colocated-test`, `forbid-import`, `forbid-pattern`.

## Decisions made (this handoff)
1. Split checks by **coverage**. **Exhaustive** kinds fully decide the rule, so the model is told to skip it: `max-lines`, `colocated-test`. **Partial** kinds only catch a subset of violations, so the model must still review the rule: `forbid-import`, `forbid-pattern`.
2. For a rule with a partial check, the prompt says: "a mechanical check already reports these locations (list them); do not repeat them, but still look for violations of this rule that the check cannot see". The dedupe that drops a model finding repeating a check finding (same file and rule, same or nearby location) stays.
3. Optional per-rule override in `rules.md`: `check-coverage: exhaustive | partial` (default from the kind). Lets a user declare a `forbid-pattern` exhaustive when it really is. Parse/serialize round-trip must stay stable.
4. Cost: partial rules go back into the model prompt, so `standard` spends a little more than in v0.7.0. Report the difference.

## Files to touch
`src/core/checks/*` (coverage metadata per kind), `src/core/review.ts`, `src/core/prompt.ts`, `src/core/agent/prompts.ts`, `src/core/rules/{parse,format}.ts` + `src/core/config.ts` (the `check-coverage` field), tests next to each, `README.md`, `CHANGELOG.md` (v0.7.1 entry in the fixed format), `package.json` version 0.7.1.
Do NOT edit `DECISIONS.md` or anything under `.cursor/` (the orchestrator does it).

## Implementation steps (strict order)
1. Add coverage metadata to the check kinds and expose it to the prompt builders.
2. Change both prompts (single and agent) per decision 2; keep the exhaustive behaviour unchanged.
3. Add the optional `check-coverage:` field with round-trip tests.
4. Tests (mock model): exhaustive rule still skipped; partial rule is listed to the model with the already-found locations; duplicate of a check finding still dropped; a model finding on a location the check cannot see is kept; parse/serialize of the new field.
5. Real verification, one run, cap US$0.05, `--budget-usd` set: clone `https://github.com/blanck1945/causas-viewer` to a temp dir OUTSIDE the repo (never modify or push it), check out `feat/case-reminders` with the repo rules plus the same `check:` lines B45 used (see `guardrails/CHANGELOG.md` v0.7.0 and the B45 results in `C:\Users\elabu\AppData\Local\Temp\b45-results` if present), and run `guardrails review --mode standard`. Expected: the accented-Spanish comment at `useReminders.ts:20` comes from the check, AND the unaccented heading in `ReminderList.tsx` (`Recordatorios`) is reported by the model. Also run `feat/clients-page` (clean) once in standard: expected no findings. If either expectation fails, report it as is; do not adjust the cases.
6. `pnpm check` and `pnpm build` green; one commit; CHANGELOG entry v0.7.1 with What we did / What we observed (the run results and the cost difference) / Next.

## Done criteria (checklist)
- [ ] Exhaustive vs partial coverage implemented and documented.
- [ ] `check-coverage:` optional field with stable round-trip.
- [ ] Tests listed in step 4 pass; `pnpm check` and `pnpm build` green.
- [ ] Real run: heading `Recordatorios` reported; clean branch has no findings; real cost reported.
- [ ] CHANGELOG v0.7.1 and version bump in the same commit. No push. No secrets printed.

## Risks and edge cases
- More model spend on repos with many `forbid-pattern` rules; mitigated by the user's `check-coverage: exhaustive` override.
- The model might repeat check findings in a slightly different location; keep the dedupe tolerant (same file, nearby lines).

## Out of scope
Changing the accent regex itself, new check kinds, mode presets, cloud infrastructure.

## Open questions
None blocking. Whether `forbid-import` should default to exhaustive is left as partial, the conservative choice.

## Execution
_Pending._

## Quality
Written by the orchestrator from the B45 report of the previous executor run.
