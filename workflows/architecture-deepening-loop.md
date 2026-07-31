# Architecture Deepening Loop

## Purpose

Run a bounded architecture-improvement loop for this repo. The manual loop uses
`$improve-codebase-architecture` to find deepening opportunities, then implements
at most one low-risk improvement per round, re-scores the repo, and stops when the
architecture is good enough.

This workflow is for preventing endless optimization. It optimizes until the repo
is maintainable enough, not until no refactor remains.

For scheduled or delegated architecture work, the source of truth is the Loop
Engineering WorkOrder path in `docs/intelligent-automation.md`. This file is the
local/manual compatibility workflow used by `/arch-loop` and `$arch-loop`.

## Trigger

Run on demand when the maintainer asks for any of:

- `/arch-loop`
- architecture health loop
- architecture score and improve
- auto-eval architecture
- repeat `$improve-codebase-architecture` until good enough

Do not run on every PR or schedule. This is a deliberate maintenance loop.

Project shortcut:

- `/arch-loop` runs the strict loop with defaults: target score `95`, max rounds
  `3`, fresh scan, no reused candidate pool.
- `/arch-loop score-only` rescans and scores without editing files.
- `/arch-loop target=90 max_rounds=1` runs a one-round stretch pass that still
  must stop before speculative polish or ungrilled interface design.

## Inputs

Defaults:

- target score: `95`
- minimum healthy score: `82`
- stretch score: `95`
- max rounds: `3`
- max candidate per round: `1`
- minimum candidate strength to auto-implement: `Strong`
- allowed candidate strength with caution: `Worth exploring`, only when the
  improvement is low-risk and small-step

Optional overrides:

- target score
- max rounds
- focus area
- dry-run only

## Score Rubric

Score out of 100 after baseline and after every round. The default target is
`95`: high enough to avoid unnecessary edits when the architecture is already
strong, and explicit enough to stop optimization-for-its-own-sake. Treat `82` as
the minimum healthy line, not the default stop line. Scores at or above `95`
should stop without code changes unless the user explicitly asks for a narrower
verified improvement.

- Module depth: 25
  - Deep modules hide meaningful behavior behind small interfaces.
  - Penalize shallow modules whose interface nearly matches their implementation.

- Locality: 25
  - A domain change should concentrate in one module.
  - Penalize behavior that requires callers/tests to know several storage modules
    or adapters.

- Testability: 20
  - Important behavior should be tested through the same interface callers use.
  - Penalize tests that seed many internal stores to express one domain concept.

- Domain clarity: 15
  - Code and tests should use `CONTEXT.md` terms: Workspace, Project, Project
    Session, Independent Project, Agent, Agent Kind, Chat Scope, Project Group.
  - Penalize old terms that obscure the current domain model.

- Change safety: 15
  - Improvements should be shippable as small commits.
  - Penalize broad rewrites, speculative seams, and user-facing behavior changes
    without focused tests.

## Stop Conditions

Stop immediately when any condition is true:

- score is greater than or equal to target score
- score is greater than or equal to the stretch score and the remaining
  candidates are mostly elegance/polish rather than reliability or locality
- max rounds have completed
- no remaining candidate is high-leverage, low-risk, and small-step
- the next candidate requires a new interface design that has not been grilled
- verification fails and the failure is not clearly caused by this round's scoped
  change

When stopping below target, write a brief explaining why continuing is not
currently justified.

## Round 0: Baseline

1. Read `CLAUDE.md`.
2. Read `CONTEXT.md`.
3. Read relevant ADRs under `docs/adr/`.
4. Run `$improve-codebase-architecture`.
5. Use the generated report plus direct code inspection to assign a baseline
   score using the rubric.
   Read generated reports yourself; do not open them in a browser unless the
   user explicitly asks.
6. Select the first candidate only if it satisfies all of:
   - `Strong`, or clearly low-risk `Worth exploring`
   - improves locality or module depth
   - can be completed in one small patch
   - can be verified with focused tests
   - does not contradict an accepted ADR unless the report explicitly says the
     ADR should be revisited

If the baseline score already reaches the target, stop without editing code.

## Implementation Round

For each round from 1 to max rounds:

1. Announce:
   - current score
   - selected candidate
   - expected score movement
   - focused verification command

2. Follow TDD for behavior-preserving refactors:
   - Write a focused regression/refactor guard first.
   - Run it and confirm it fails for the expected reason.
   - Make the smallest production change that passes it.
   - Keep the candidate scope narrow.

3. Prefer deepening over layering:
   - Delete duplicate paths when possible.
   - Move policy to the module that already owns the domain concept.
   - Do not introduce a seam unless two real adapters/callers justify it.
   - Treat the module interface as the test surface.

4. Run verification:
   - focused tests for the touched behavior
   - `npm run lint:types`
   - `npm run lint`
   - full `npm test` when touching `src/core`, shared state, adapters, or a
     cross-surface read model

5. Re-score using the same rubric.

6. Decide:
   - score >= target: stop
   - round == max rounds: stop
   - next candidate is not high-leverage and low-risk: stop
   - otherwise continue with the next round

## Candidate Selection Rules

Auto-implement:

- A duplicate row/read model can be collapsed behind an existing deeper module.
- A policy already duplicated across two real adapters can move behind a shared
  module without changing rendering.
- A test currently crosses several internal stores for one domain concept and can
  instead target one module interface.

Checkpoint before implementing:

- The candidate needs a new interface.
- The candidate changes user-facing behavior.
- The candidate changes persistence format.
- The candidate contradicts an ADR.
- The candidate is `Speculative`.
- The change crosses project/session/agent state and the restart-safety or
  desktop-side self-healing behavior is unclear.

Reject for this loop:

- Cosmetic cleanup.
- Large-file splitting without deeper interface.
- New abstraction over one adapter.
- Test-only extraction that does not improve locality.
- Refactors whose main benefit is "cleaner code" rather than module depth,
  locality, testability, or domain clarity.

## Output Format

After baseline and every round, output:

```text
Architecture score: NN/100

Score movement:
- Module depth: A -> B
- Locality: A -> B
- Testability: A -> B
- Domain clarity: A -> B
- Change safety: A -> B

Selected candidate:
- name
- reason
- files

Changed:
- ...

Verification:
- command: result

Stop decision:
- continue | stop

Reason:
- ...
```

## What Gets Persisted

The workflow run itself should not write architecture reports into the repo.
`$improve-codebase-architecture` writes HTML reports to the OS temp directory.

Repo changes are limited to the implementation round's scoped code/tests/docs.

If the same rejected candidate keeps reappearing for a load-bearing reason, offer
to record an ADR so future runs do not re-suggest it.

## Automation Path

The automated path already exists in Loop Engineering:

- Scheduled project or workspace architecture jobs materialize a bounded
  WorkOrder.
- The Loop Supervisor leases an isolated worker, verifies the configured
  project/workspace paths, assesses the architecture score, and stops when the
  target score is met.
- If a change is justified, it runs a narrow implementation round, verifies,
  commits, creates or updates one PR for the run, and lets the system gate check
  PR/CI/mergeability/switch-back/clean-worktree evidence.
- Reports are read by the agent/system; they are not browser-opened unless the
  user explicitly asks.

Keep this manual workflow aligned with `docs/intelligent-automation.md`; do not
add a second automation semantics here.
