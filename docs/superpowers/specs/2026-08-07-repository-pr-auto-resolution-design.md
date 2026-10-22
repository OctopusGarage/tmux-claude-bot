# Repository PR Auto-Resolution Design

## Goal

Make scheduled repository-wide PR review reliably close the loop for every open
PR. The active worker may inspect, repair, ready, merge, or close a PR, but the
bot must preserve a durable decision for each PR and must never mistake a
temporary execution problem for a human-only blocker.

## Current gap

The repository PR review prompt already describes draft handling, bounded repair,
conflict resolution, CI checks, and merge/close decisions. The orchestration
layer does not yet carry those decisions in a structured form. In particular,
the repository review queue currently treats a supervisor result of `blocked` as
a terminal queue outcome. A transient CI/check issue, an unavailable worker, or
an incomplete review can therefore stop future automatic processing even when a
retry is safe.

## Design

### Structured per-PR decisions

Extend the supervisor final summary with an optional, task-governed
`pullRequestDecisions` array. Repository PR review WorkOrders require one entry
for every in-scope PR inspected in that round. Each entry contains:

- PR number and repository identity;
- one outcome: `merged`, `closed`, `retry`, or `manual-review`;
- an allowlisted close reason when the outcome is `closed`:
  `duplicate`, `obsolete`, `non-actionable`, or `invalid`;
- concise evidence and the next step.

`merged` and `closed` are terminal decisions. `retry` is explicitly
non-terminal. `manual-review` is the only intentional human-intervention
outcome and must include a concrete reason and evidence. A PR must never be
closed merely because it is draft, conflicting, old, or currently failing CI.

### Queue lifecycle

The repository review queue gains an explicit `manual-review` terminal status.
Supervisor outcomes are mapped as follows:

- all in-scope PR decisions are terminal (`merged` or allowed `closed`):
  `completed`;
- at least one decision is `retry`, or the run fails with retryable orchestration
  evidence: return the item to `retry-wait` with bounded exponential backoff;
- only explicit `manual-review` decisions remain: `manual-review` terminal;
- invalid or missing decision evidence: retry as orchestration failure, not
  `blocked`;
- proven ownership, permission, policy, or external human dependency: retain
  `manual-review` with the exact evidence.

Retry admission remains immediate when a supervisor becomes available; it does
not wait for the original cron occurrence. Existing queue leases and project
conflict planning remain authoritative, so two workers cannot process the same
repository review occurrence concurrently.

### Deterministic acceptance

The system gate validates repository PR review summaries before accepting the
run:

- every decision has a valid PR number and allowed outcome;
- closed decisions use only the allowlisted reasons and include evidence;
- retry and manual-review decisions include a non-empty next step/reason;
- a run cannot be `completed` while any decision is `retry` or
  `manual-review`;
- the final report records the per-PR outcome and queue disposition.

The worker remains responsible for code review and GitHub interaction. The bot
remains responsible for parsing, deterministic validation, queue state, retry
backoff, and final acceptance. No model-provider API is introduced.

### Prompt and documentation alignment

The repository PR review policy will explicitly require the structured decision
array and the close-reason allowlist. It will also distinguish retryable
execution/check blockers from genuine human decisions. User-facing automation
documentation will describe the three observable outcomes: completed,
retrying, and manual review.

## Error handling

- Worker capacity, dispatch readiness, missing/invalid final summaries, pending
  checks, and bounded repair failures are retryable.
- A branch that cannot be safely modified because it is external, protected, or
  permission-restricted is `manual-review` unless the PR is clearly obsolete or
  invalid with evidence.
- Product, migration, security-design, or broad refactoring judgment is
  `manual-review`; the worker must not guess.
- Queue lease expiry reclaims the item as pending and preserves the last error.
- Duplicate active reviews remain deduplicated by repository and scheduled
  occurrence.

## Verification

Add tests for:

1. parsing and validating structured PR decisions;
2. rejecting unsafe close reasons and incomplete manual decisions;
3. retrying blocked/retryable repository review outcomes;
4. terminalizing only all-terminal PR decisions;
5. preserving queue deduplication, lease recovery, and serialized dispatch;
6. prompt contract coverage for draft, conflict, close, retry, and merge rules.

The implementation slice will run the focused Vitest suites followed by
`npm run verify:local`.
