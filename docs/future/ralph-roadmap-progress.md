# Ralph roadmap delivery ledger

Goal: finish all unfinished items in the Ralph assessment, verify each reviewable
slice and commit it to `dev`. This ledger tracks the full goal; a green pilot does
not complete the roadmap. The baseline assessment remains
[the source roadmap](2026-09-15-ralph-loop-assessment.md).

## Delivery requirements

| ID | Requirement | Current evidence / remaining proof | Status |
| --- | --- | --- | --- |
| R1 | Stable WorkOrder identity, complete acceptance items and durable checkpoint context | Pilot reader and handoff tests; broader family contracts still required under R8 | Pilot complete |
| R2 | Current-attempt evidence and immutable iteration history | Freshness exclusion and append-only prepared/started/settled transport records bind queue IDs, contract, prompt and session; append-only successor links serialize transport attempts; acceptance-generation binding remains open | Partial: durable transport history |
| R3 | Crash-window reconciliation and single execution ownership | Prepared queue restoration claims each attempt once; append-only ownership links fence different IDs and start/cancellation races across processes. Started/invalid records await reconciliation. Before/after enqueue, commit, checkpoint, stale generation and live native goal still need end-to-end proof | Partial |
| R4 | Independent behavioral verification bound to contract and repository revision | Git facts are system-observed, tests remain agent-reported. Approved command or authoritative CI execution/evidence must gate every required item; never execute checkpoint-supplied commands | Open |
| R5 | Shared policy, durable budgets and progress-based stopping | Pilot shared continuation/revision caps and absolute deadline pass; full transport accounting, repeated-evidence policy and parent/child budget proofs remain | Partial |
| R6 | Operator progress, stop reasons, remaining allowance and safe pause/resume | Need command-backed controls and shared CLI/TUI/chat/MCP projections with documented lifecycle semantics, redacted paths and contract tests | Open |
| R7 | External CI/quota/quiet-hours waiting and admission | Need persisted retry conditions, no agent polling, capacity release without losing workspace ownership, and nonrenewable lifetime deadline | Open |
| R8 | Task-family rollout and task-specific stop policy | Bug-fix/test coverage, architecture/security, parent-budget harness, same-repository PR repair, daily audit/project recovery/runtime guardian and read-only opportunity discovery need explicit contracts and acceptance tests | Open |
| R9 | Workspace iteration and recovery | Audit existing workspace builder/recovery before extending; prove every member revision/path, missing-member failure and isolation/PR parity | Open |
| R10 | Context reconstruction and native goal ownership | Preserve same-session execution, validate reconstruction before compaction/replacement, prove no competing dispatch while a native goal owns a live attempt | Open |
| R11 | Cross-surface alignment and end-to-end completion audit | Update business/alignment docs, capability matrix, applicable commands/skills/surfaces; run full local gates and inspect requirement-specific evidence for all rows | Ongoing |

## Required end-to-end scenarios

- [ ] Complete a three-item task across slices without repeated verified work or a second WorkOrder/branch/PR.
- [x] Reject claimed completion with pending mandatory items (pilot checkpoint acceptance tests).
- [x] Reject stale revision and foreign-contract evidence (pilot real Git and reader tests).
- [ ] Stop or change bounded diagnosis for repeated identical evidence, rather than trusting sequence growth.
- [ ] Reconcile crashes before enqueue, after enqueue, after commit and after checkpoint without duplicate active workers or external effects.
- [x] Preserve revision/continuation consumption and deadline across runner reentry (pilot budget tests; queue restoration still R3).
- [ ] Prove cancellation, late completion and shutdown races across live/restored execution, not just the local runner.
- [ ] Wait for CI/quota/quiet hours without busy agent polling; recheck admission before resumption.
- [ ] Reject competing continuation while a native goal or surviving attempt is active.
- [ ] Prove source and workspace member mismatches block without touching an unrelated tree.
- [ ] Preserve no-delta success with current complete acceptance evidence.
- [ ] Prove pending work cannot become success through generic follow-up text across task families.
- [ ] Record accepted-item completion, repeated work, active time, failure recurrence, rejected false completions, resume outcomes and owner interventions.

## Slices

- Pilot merged: `7dfdf5bf`, `0907c0d7`, `180c0603`; assessment: `89f78a53`.
- Invocation freshness slice: reject pre-existing final-summary files during active delegation execution and transport recovery; preserve a newly written or explicitly returned current summary. Regression tests cover partial revision, failure/timeout recovery, atomic rewrites and invalid artifacts. Focused Loop/Autopilot suite: 52 files, 678 passing tests. `npm run verify:local` passed: 400 files, 4,445 tests passed and 4 skipped.


- Durable transport history slice: append-only preparation, exclusive start claims, immutable settlement and freshness-aware live/restored queue probes. Prepared restoration validates prompt, session and contract; started/invalid attempts are retained for reconciliation. Full crash recovery and independent acceptance remain open. `npm run verify:local` passed, including coverage tests, type checks, dependency boundaries, lint and smoke.

- Transport ownership slice: reserve one initial/successor attempt per WorkOrder before context reset or lease mutation; fence unclaimed callbacks and atomically arbitrate start versus pre-start cancellation. Ownership failures disable summary recovery. Cross-process reservation and cancellation tests supplement restored-message regressions. Surviving-worker recovery, interrupted reservations and final acceptance reconciliation remain open. `npm run verify:local` passed: 401 test files, 4,463 passing tests and 4 skipped.

## Next recovery boundary

`completeRestoredSupervisorWork` currently maps the restored summary directly
into `completeLoopSupervisorRun`. Restored completion must rejoin the normal
system acceptance path (`runSupervisedSystemGateOutcome`) before publishing
success or treating follow-ups as final. A settled transport record is not proof
that acceptance or report publication completed. This remains part of R3/R4,
alongside recovery of interrupted ownership reservations and surviving workers.

The goal stays active until every requirement and end-to-end scenario has direct
current-state evidence. No live user jobs, provider integrations, or remote pushes
are implied by this implementation goal.
