# Proposal: a decision log (`DECISIONS.md`) as a first-class Baking artifact

**Status:** proposal, not implemented in Baking. Written from a real worked example.
**Worked example:** `DECISIONS.md` at the root of this repo (Guardrails project, 21 entries, D-001 to D-021). Read it next to this guide.
**Audience:** whoever maintains Baking (config, agents, skill, CLI), or an agent asked to add this to Baking.

---

## 1. The gap

Baking already keeps four records per project. None of them answers "why did we do it this way?".

| Artifact | Question it answers | Written by | Lifetime |
|---|---|---|---|
| Handoff (`.cursor/handoff/*.md`) | What must this task do, and how do we know it is done? | planner | one task |
| Metrics (`.cursor/baking/metrics/runs.jsonl`) | Which route ran, which model, what did it cost? | orchestrator at close | append-only |
| Baking memory (`baking memory`) | Loose observations across sessions | orchestrator | global, unstructured |
| `CHANGELOG.md` (in this example) | What changed in each version, what did we observe, what is next? | orchestrator | per version |
| **Decision log (`DECISIONS.md`)** | **Why was X chosen over Y, by whom, on what evidence, and is it still in force?** | orchestrator (proposed) | whole project |

Without it, a new planner (or the user, weeks later) sees the code and the handoffs but cannot tell which choices were deliberate, which were forced by a measurement, and which the user imposed. The visible symptom: a fresh planner re-opens settled questions (for example "why not AWS?", "why not a sandbox?") and re-derives history.

## 2. Why this format

It is an ADR-lite (architecture decision record), reduced to what matters in a fast-moving agent workflow:

- **One file, append-only, numbered** (`D-001`, `D-002`, ...). Easy for an agent to read whole, easy to link from handoffs and metrics.
- **Status instead of deletion.** A reversed decision is never edited away; it is marked `Superseded by D-NNN` and the new one explains the reversal. The reversal is often the most informative part (in the example, D-013 replaced an earlier choice after two real failures).
- **Evidence in the "why".** Numbers, failures and user requests, not opinions.
- **Rejected alternatives are mandatory.** They are the part that stops the next planner from re-proposing them.

## 3. Entry format

```
### D-NNN — <short title stating the decision>
- **Date:** YYYY-MM-DD · **Status:** Current | In progress | Planned | Superseded by D-NNN · **Version:** vX.Y.Z (optional)
- **Decision:** what was decided, one or two sentences.
- **Why:** the evidence or constraint: a measurement, a failure, a user request, a cost.
- **Rejected:** alternatives considered and why they were not chosen.
- **Consequence:** what this commits us to, known limits, and what it blocks.
- **Decided by / source:** user | orchestrator | planner, and where it came from (handoff path, PR, measurement, chat).
```

Rules:
1. Append at the end; numbers are never reused or reordered.
2. Never delete. Supersede.
3. A `Planned` entry lists its **open decisions** explicitly, so a planner knows what is still undecided.
4. Cross-references use `D-NNN` and must resolve (see the checker in section 6).
5. If the reasons were inferred rather than stated by the user, say so (see "Provenance" below).

**Worked example (from `DECISIONS.md`, shortened):**

```
### D-013 — A finding that cites an active rule skips the type filter; an invented ruleId is stripped, not the finding dropped
- Date: 2026-09-24 · Status: Current (v0.4.0)
- Decision: the comment-type filter only applies to findings with no rule. If the model cites a ruleId that
  does not exist, the id is removed and the finding is kept.
- Why: two real failures. A violation of `english-only` was discarded for being type `style`, and with glm-5.3
  two real bugs were lost because the model attached made-up ruleIds. Replaces the original choice made in B32,
  which discarded the whole finding.
- Decided by: orchestrator, after measuring on the test app.
```

```
### D-016 — Review modes per PR: basic, standard, deep
- Date: 2026-09-24 · Status: In progress (v0.7.0)
- Decision (user request): the user chooses depth per PR. Priority: CLI flag, PR label, description line,
  auto rules in config, then standard. `prOverride: "none"` stops a PR author from relaxing their own review.
- Rejected / accepted risk: by default labels win, so an author can lower their own PR's mode. Documented and
  mitigated with `prOverride`.
```

## 4. When to write an entry (triggers)

Write one when any of these happens; otherwise do not.

1. The **user states a preference or a constraint** ("use Vercel for the MVP", "test with the cheap model", "I want modes per PR").
2. A **real choice between alternatives** was made and something was rejected.
3. A **measurement changed the course**, including reversals of earlier decisions.
4. A **security, permission or cost boundary** was set or moved.
5. Something was **deliberately deferred** with open questions.

Do **not** log routine implementation, ordinary bug fixes, or refactors with no design consequence. Those belong in the changelog and the git history.

## 5. Proposed integration points in Baking

| Where | Change |
|---|---|
| **Project template / `enable-project`** | Scaffold an empty `DECISIONS.md` with the header, the companion-documents table and the format above. |
| **Planner template (`planner.md`)** | Before proposing, read `DECISIONS.md`. In the handoff, `## Decisions made` lists the `D-NNN` it relies on and proposes new entries. It must not silently contradict a `Current` decision: it either respects it or proposes a superseding entry with its evidence. |
| **Mandatory close (skill)** | After the YAML and the metrics line, a third step: append `D-NNN` entries for any decision made during the run, including ones the user gave in mid-run messages. |
| **Close YAML** | New optional field `decisions: [D-021]`. |
| **Metrics schema** | New optional field `decisions` (array of ids), so cost and routing can be joined with decisions later. |
| **Gate-out** | Q&A does not write entries. A user statement of preference inside Q&A does (trigger 1). |
| **Review step** | `plan_fit` review can note "re-opened a Current decision" as a routing defect. |

### Proposed CLI (not implemented)

```
baking decisions init            # create DECISIONS.md from the template
baking decisions add "<title>"   # append a numbered stub and print its id
baking decisions list [--status current|in-progress|planned|superseded]
baking decisions check           # validate the file (see below)
```

## 6. What a checker should verify (learned from a real slip)

While building the example, two cross-references pointed to the wrong entry (`D-018` instead of `D-019`) after entries were renumbered. Nothing caught it; a human read did. A checker should flag:

- duplicate or non-sequential ids;
- any `D-NNN` mentioned in the file (or in a handoff) that does not exist;
- entries missing date, status or "Why";
- `Superseded by D-NNN` where D-NNN does not exist or does not mention the entry it replaces;
- `In progress` entries older than N days with no linked changelog version.

## 7. How the worked example was actually built (and what to do better)

What happened, in order:

1. The user asked, mid-project, for "a log of decisions, I do not know if Baking does it".
2. The orchestrator checked what Baking already offers (handoff, metrics, memory) and confirmed none records rationale.
3. It reconstructed the decisions **retroactively** from the whole conversation, grouped them by area (product and architecture, models and cost, review quality, validation and process, planned), and wrote each in the entry format.
4. It added an index table of companion documents, a "how to maintain" paragraph, and an appendix with the token and duration of every subagent run (useful for the cost concern the user raised).
5. It re-read the file and fixed the cross-references.
6. It closed the run with the YAML and one metrics line, as Baking requires.

What to do better (real weaknesses of the example):

- **Retroactive writing.** The entries were written after the fact from a long session. Some "why" text is the orchestrator's reading of the conversation, not something the user stated. The file says so in its header. Fix: write each entry **at the moment of the decision**, as part of the run's close, so the reasons are contemporaneous.
- **Numbering follows topics, not time.** The example groups entries by area, so ids are not chronological. Fix: number chronologically and use a tag (`[architecture]`, `[cost]`, `[quality]`, `[process]`) for grouping.
- **No consistent "decided by" field.** In the example it appears inline ("user request") in some entries and is missing in others. The format above adds it.
- **No automated check.** See section 6.

## 8. Acceptance criteria for adding this to Baking

- [ ] `enable-project` (or `baking decisions init`) creates `DECISIONS.md` from the template.
- [ ] The planner template reads it first and lists relied-upon ids in `## Decisions made`.
- [ ] The skill's mandatory close appends entries and reports `decisions:` in the YAML.
- [ ] `metrics.schema.json` accepts the optional `decisions` array.
- [ ] `baking decisions check` catches the errors in section 6, verified against the example file (it should pass on it after the two known cross-reference fixes).
- [ ] Documentation states when to write and when not to (section 4).

## 9. Where the example lives

`C:\Users\elabu\Desktop\side-apps\codereview-ai\DECISIONS.md` — the full worked example.
`C:\Users\elabu\Desktop\side-apps\codereview-ai\.cursor\handoff\2026-09-24-guardrails-context.md` — a handoff that points to it as the source for `## Decisions made`, showing the link between the two artifacts.
