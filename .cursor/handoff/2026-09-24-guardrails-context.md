# Plan: Guardrails — context handoff (how it was built, where it stands)

**Handoff:** `.cursor/handoff/2026-09-24-guardrails-context.md`
**Type:** PLAN-ONLY context document. Not an instruction to execute anything. It exists so a fresh Baking session (planner-hyper or executor) can continue without re-deriving history.
**Companions:** `DECISIONS.md` (why), `guardrails/CHANGELOG.md` (versions: did / observed / next), `PLAN.md` + `PLAN-DETAILED.md` (original plan and backlog B01–B29), `.cursor/baking/metrics/runs.jsonl` (routing and consumption).

## Objective
Guardrails is an AI pull-request reviewer in the style of Greptile. It reviews each PR with whole-repo context, learns the repo's own rules (from `CLAUDE.md`, lint/TS configs, docs) and lets the user also write rules in `.guardrails/rules.md`. Cloud first (GitHub App + service on Vercel); a local CLI and a pre-push hook share the same core.
Guiding principle from the user: the more context the tool has, the less the user has to write.

## Minimal context

### Where things live (Windows 11; Git Bash or PowerShell)
| Thing | Location |
|---|---|
| Project root (git) | `C:\Users\elabu\Desktop\side-apps\codereview-ai` — branch `master`, `origin` = `github.com/blanck1945/guardrails` (public) |
| Application | `guardrails/` — Next.js 16, TypeScript, pnpm, vitest, AI SDK 7. Scripts: `pnpm check` (typecheck + tests), `pnpm build`, `pnpm guardrails <init\|review\|hook\|smoke>`, `pnpm eval validate` |
| Core | `guardrails/src/core` (`review.ts`, `agent/`, `rules/`, `findings/`, `checks/`, `workspace/`, `init/`, `models.ts`, `pricing.ts`, `cost.ts`) |
| Cloud | `guardrails/src/cloud` + `guardrails/app/api/{webhooks/github,health}` |
| Eval set | `guardrails/eval` (41 cases: szz, injected, clean, injection; miners under `eval/mine`) |
| Deploy | Vercel project `guardrails`, **Root Directory `guardrails`**, deploys from `master`. Stable URL `https://guardrails-augusto-pastranas-projects.vercel.app` (Deployment Protection is OFF on purpose, see D-009) |
| GitHub App | `guardrails-boogiepop`, App ID `5061316`, only on the owner account, installed only on `blanck1945/causas-viewer`; permissions contents:read, pull_requests:write, metadata:read; event pull_request |
| Test app | `C:\Users\elabu\Desktop\side-apps\causas` (React 19 + TS) → remote `github.com/blanck1945/causas-viewer` (public). `main` has `.guardrails/rules.md` with 5 active rules. PRs #2–#7 are open test PRs. |
| Answer key for the 6 test PRs | `C:\Users\elabu\Desktop\side-apps\causas-pr-answers.md` — **secret, outside the repo, never commit it** |
| Local secrets | `guardrails/.env.local` (git-ignored): `ZAI_API_KEY`, `GUARDRAILS_MODEL=zai:glm-5.3`, `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY` (single line, literal `\n`), an unused `AI_GATEWAY_API_KEY`. **Never print or commit values.** Same variables are set in Vercel. |
| Baking | `baking require on` was run here (`.cursor/baking/required.json`). CLI: `node ~/Desktop/side/baking/bin/baking.js <cmd>` (not on PATH). Config in `~/Desktop/side/baking/config.json`: `requireHandoffFile: true`, `maxParallelSubagents: 2`, `forcePlanIfNoHandoffExists: true`. |

### How the review works (short)
GitHub webhook → `route.ts` (signature check, dedupe, ack 202) → `review-pr.ts` reads config and rules from the **base** commit, downloads base and head tarballs to `/tmp`, runs the agent (tools: read_file, grep, list_files, find_references, report_findings) through `reviewDiff`, filters and publishes inline comments. Falls back to single-call mode if the tarball fails. Model: Z.ai `glm-5.3` via `zai:` resolver.

## How it was built (process, in order)
1. **Research.** Read greptile.com, its pricing, docs and two blog posts (sandboxing, "make LLMs shut up"). Findings: no public model names; agent runs in a rootless Podman container; comment filtering uses embeddings of accepted/rejected comments; config via `greptile.json` and `.greptile/`; no predefined rule packs.
2. **First plan** (`PLAN.md`) and a working MVP scaffold (webhook, core, config). Typecheck clean.
3. **Deep plan.** `planner-hyper` produced `PLAN-DETAILED.md` (11 sections, backlog B01–B29 plus spikes S1–S3). It found several defects in the MVP that the backlog fixed (config read from head, non-durable webhook, exceptions on bad JSON, glob bug, deprecated `generateObject`).
4. **Execution in batches** with `executor-mecanic` (B01–B02) and `executor` (everything else), one commit per task, no pushes by agents. Order: B03/04/05/08 → B06/09 → B07/10 → B12/13 → rules, init, review (B30–B32) → model resolver and spend control (B33) → review CLI, hook, GitHub App, deploy config (B34–B36) → three fixes F1–F3 → noise and grounding (B40) → cloud agent over tarball (B41) → determinism, modes, changelog (B42–B45, in progress).
5. **Real-model tests, cheap first.** Z.ai GLM for mechanics (`smoke` command), with spend caps. Every measurement surfaced a defect that became the next fix (see CHANGELOG "What we observed").
6. **Test application.** `causas` with 7 rules in `CLAUDE.md`. Local scenario branches first (7 branches, all detected), then 6 realistic PRs with hidden problems, reviewed blind by the deployed App, then compared with the answer key.
7. **Infrastructure by the user, guided step by step.** GitHub App created in the browser, Vercel imported from GitHub, env vars typed by the user; secrets moved to the clipboard through scripts, never echoed.

### Verification routine used after every agent delivery (repeat it)
1. `git status` clean, `git log --oneline` shows the expected commits.
2. `pnpm check` green and `pnpm build` compiles.
3. Secret scan of tracked files: the Z.ai key, the webhook secret, `vck_`, `gh[ps]_` tokens, and a PEM body must all have zero hits.
4. Read the agent's deviations list and check the ones that change behaviour.
5. Only then push (Vercel redeploys `master`). Confirm deploy with the GitHub commit status and `/api/health`.

### Environment gotchas (real, all cost time once)
- The Bash tool halves backslashes. Build strings containing backslashes with `String.fromCharCode(92)` inside a script file, not inline. This corrupted the GitHub private key once (real newlines instead of literal `\n`).
- `pnpm guardrails ...` prints a banner on stdout before `--json`; slice from the first `{`.
- `sleep` chains are blocked; use `run_in_background` or a Monitor loop.
- `tsx` cannot load `octokit` (ESM only); the cloud smoke test is a vitest file (`pnpm smoke:cloud`).
- Z.ai: JSON mode strips the `json` token; reasoning models are slow; `reasoning_effort: low` is set for glm-5.3.
- Windows: file symlink test is skipped; LF→CRLF git warnings are harmless.
- The Claude Code scratchpad directory can disappear mid-session; use `$TEMP` for temp clones.
- Agents once overwrote `guardrails/.gitignore`; check diffs of config files.
- An Anthropic session limit (HTTP 429) killed one long agent; resume it with SendMessage instead of restarting, and check the working tree first.

## Current state (2026-09-24)
- **Production:** deployed commit `8d756a0` (through B41). Health OK, webhook returns 401 without signature, all 7 PRs in `causas-viewer` got a review from the App.
- **Local, unpushed:** B42a (mechanical `check:` rules), B42b (temperature 0), B42c (exhaustive per-rule pass) committed, `HEAD b55577b`. An executor (agent id `a2069ab2db36208e7`, resumed) is finishing B43 (review modes basic/standard/deep), B44 (CHANGELOG + `guardrails/CLAUDE.md`, version bumps 0.6.1 → 0.7.0) and B45 (real re-measurement, cap US$0.40).
- **Untracked, on purpose:** `.cursor/` and `DECISIONS.md`; commit them after the executor finishes to avoid mixing with its commits.
- **Measured:** 6 of 7 seeded problems found in 6 PRs, 0 false positives, one miss (a Spanish comment: model omission, not filtering). One run per PR, so no statistical claim.

### Honest gaps versus the original plan
- Phase 0 evaluation is **incomplete**: runner, judge and calibration (B14–B17) were never built; the 25 real cases (B11) and the judge labels (B16) need the user; the formal go/no-go for risk R1 was not taken. Evidence so far comes from the causas PRs instead.
- No database, queue, durable dedupe, feedback capture, dashboard or billing (B18–B22, B26–B28 not done). Dedupe is in memory.
- Spikes S1 (Sandbox) is no longer needed (D-004); S2 (Workflow) and S3 (Gateway) were not run.
- `init` on install, incremental refresh, learning from feedback: planned, not built (D-019).
- Cost figures are estimates from reported tokens; the Z.ai dashboard is the truth (the user has not shared it yet).

## Decisions made
See `DECISIONS.md` (D-001 to D-020). The ones a new planner must not reopen without a reason: core independent of GitHub (D-002), Vercel for the MVP (D-003), tarball instead of Sandbox (D-004), rules read from the base commit (D-007), minimal App permissions (D-008), Z.ai for testing and Claude for quality gates (D-010), rule-citing findings bypass the type filter (D-013).

## Files to touch (next work, none started)
Planning first, no code: a new handoff for D-019 and D-020. Likely code areas later: `src/core/init/*`, a new refresh module, `src/cloud/webhook.ts` (installation events), `guardrails/github-app/manifest.json` and `src/cloud/app-permissions.ts` (only if `contents: write` is approved), `src/core/pricing.ts` and `src/core/modes.ts` (model per mode).

## Implementation steps (strict order)
1. Wait for the running executor. Verify per the routine above, then push and confirm the deploy.
2. Commit `.cursor/` and `DECISIONS.md` in their own commit.
3. Back-fill `runs.jsonl` for the earlier runs using the token and duration table at the end of `DECISIONS.md`.
4. `planner-hyper` (PLAN-DEEP) for D-019 and D-020 together: they share where state lives and what permissions the App needs. Output a handoff with the open questions below resolved or explicitly deferred.
5. Executor batches from that handoff. Max 2 subagents in parallel (`maxParallelSubagents`), one commit per task.
6. Re-measure on the 6 causas PRs after every behavioural change, 2 runs per mode, and record the result in `CHANGELOG.md` ("What we observed") before deciding the next version.

## Done criteria (checklist)
- [ ] Executor B42–B45 delivered and verified; `origin/master` equals local; deploy `success`.
- [ ] `.cursor/` and `DECISIONS.md` committed.
- [ ] Metrics back-filled for the earlier runs.
- [ ] A handoff for D-019/D-020 exists in `.cursor/handoff/` with resolved open questions.
- [ ] Every new version has a CHANGELOG entry (did / observed / next) and any new decision has a `D-NNN`.

## Assets (verify before ship)
- No secret may be committed. Run the secret scan before every push.
- The answer key must stay outside git.
- The 6 test PRs are public in `causas-viewer`; the user may want to close them or make the repo private.

## Risks and edge cases
- **Model variance:** one run per PR proves little; GLM is non-deterministic even at temperature 0 on some providers.
- **A cheap model does not predict Claude's quality.** The R1 decision needs the production model.
- **Labels can weaken a review:** a PR author can lower the mode of their own PR unless `prOverride: "none"` is set (D-016).
- **Cost under-estimation:** GLM reports 0 reasoning tokens while reasoning.
- **Tarball in memory:** very large repos can exhaust function memory before size caps apply; `GUARDRAILS_MODE=single` is the escape hatch.
- **Fork PRs** through `refs/pull/N/head` were not tested against a real fork.
- **Prompt injection from PR content:** covered by 3 eval cases and `<untrusted>` wrapping, but not measured in production.

## Out of scope (for now)
AWS or Kubernetes, self-hosting, SSO, billing, GitLab, dashboard, running the customer's tests in a sandbox, and the local-first learning loop.

## Open questions
1. Should `init` open a PR (needs `contents: write`) or post the proposed rules as an issue or comment?
2. Where does incremental state live: a lock file in the repo (works today) or the database (needs B18)?
3. What are the real Z.ai numbers (tokens and spend per day, and which endpoint bills)?
4. Keep the test repo public, or make it private and close the 6 PRs?
5. Who curates the 25 real evaluation cases (B11) and labels the judge pairs (B16), and when?
6. Rotate the keys that were pasted in the chat (Z.ai, AI Gateway) and delete the downloaded `.pem`: has the user done it?

## Execution
_Pending — do not execute until explicitly requested._ The B42–B45 executor currently running was launched before this handoff existed; its acceptance criteria live in the prompt it received and will be reconstructed here when it finishes.

## Quality
This document was written by the orchestrator from the session history, not generated by a tool. Dates, counts, paths and results are from the session; the reasons behind some decisions are the orchestrator's reading of the conversation and should be corrected by the user if they differ.
