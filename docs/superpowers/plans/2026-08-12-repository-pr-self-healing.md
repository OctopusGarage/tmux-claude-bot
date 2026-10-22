# Repository PR Self-Healing Implementation Plan

> **Goal:** Make Repository PR Review recover safe GitHub automation failures automatically, reserve `manual-review` for explicit human-only boundaries, and reopen historical false terminal records without duplicating active work.

**Architecture:** Keep the worker responsible for review, conflict repair, checks, and merge decisions. Add a deterministic core policy that validates supervisor decisions, a narrow GitHub recovery adapter for capability observation and safe workflow-policy repair, and durable queue recovery metadata. The Loop service coordinates these modules; it does not infer terminal state from prose.

**Safety:** Every GitHub mutation is account-bound, narrowly allowlisted, idempotent, and recorded before/after execution. Private-fork workflow repair may enable workflow execution but must never enable write tokens or secrets. Existing active or newer occurrences always win over historical recovery.

---

## Task 1: Replace prose-based human-boundary inference

**Files:**
- Modify: `src/core/loop/final-summary-contract.ts`
- Modify: `src/core/loop/work-order.ts`
- Test: `tests/loop/repository-pr-decision.test.ts`
- Test: `tests/loop/work-order.test.ts`

1. Add a closed `RepositoryPullRequestHumanBoundary` union for ownership, protected-branch policy, product decision, migration decision, security decision, legal/compliance, and organization policy.
2. Allow `boundary` only on `manual-review` PR decisions; reject or normalize unsupported combinations.
3. Make disposition return `manual-review` only when every manual decision contains a valid structured boundary. Free-text words such as `permission`, `access`, or `maintainer` must not terminalize work.
4. Update the Repository PR Review prompt to require the boundary code and explicitly classify `action_required`, workflow approval, same-repository conflict, pending checks, and transient GitHub failures as retryable/system-repairable.
5. Add red tests first, then implement the minimum contract change.

## Task 2: Add deterministic GitHub recovery policy and evidence

**Files:**
- Create: `src/core/loop/repository-pr-recovery.ts`
- Create: `src/core/loop/repository-pr-recovery-store.ts`
- Test: `tests/loop/repository-pr-recovery.test.ts`
- Test: `tests/loop/repository-pr-recovery-store.test.ts`

1. Define a structured observation containing repository privacy, actor permission, PR/base/head identity, workflow-run conclusion/head SHA, and private-fork workflow policy.
2. Resolve each observation to `none`, `retry`, `manual-review`, or an allowlisted repair action.
3. Support only these system repairs:
   - approve a supported pending fork workflow run;
   - for a private repository, enable fork PR workflows while keeping write tokens and secrets disabled and approval requirement disabled;
   - return retry for conflicts, pending checks, draft state, rate limits, and transient GitHub failures.
4. Persist bounded, sanitized action intent/outcome evidence in the state directory. Store repository/PR/run identifiers and policy booleans only; never store tokens, commands, or personal absolute paths.
5. Test no-op idempotency, unsafe-policy refusal, stale-head refusal, and evidence redaction.

## Task 3: Implement the account-bound GitHub adapter

**Files:**
- Create: `src/core/loop/repository-pr-github.ts`
- Modify: `src/core/loop/github-auth.ts`
- Test: `tests/loop/repository-pr-github.test.ts`
- Test: `tests/loop/github-auth.test.ts`

1. Add an injectable command boundary that obtains the configured account token without using the global active account.
2. Read PR metadata, repository metadata, actor permission, workflow runs for the exact head SHA, and private-fork workflow settings through `gh api`.
3. Execute only typed recovery actions. Re-observe immediately before mutation and require repository, PR number, head SHA, privacy, and actor permission to still match.
4. Apply private-fork settings with exact safe values and verify the resulting settings. Treat unsupported workflow approval as a capability result, not a human boundary.
5. Sanitize all surfaced errors and test every command argument without invoking the network.

## Task 4: Integrate recovery into Loop settlement

**Files:**
- Modify: `src/core/loop/service.ts`
- Modify: `src/core/loop/supervisor-outcome-settlement.ts` if settlement ownership requires it
- Test: `tests/loop/repository-review-service.test.ts`
- Test: `tests/loop/service-supervisor.test.ts`

1. Inject a Repository PR recovery controller into the Loop tick, with the production GitHub adapter as the default.
2. After a Repository PR Review summary is parsed and before queue terminal settlement, validate structured decisions and attempt any safe recovery action.
3. Persist intent before mutation and outcome afterward. A failed intent write must fail closed without mutation.
4. Convert successful repair, unsupported-but-retryable capability, conflicts, pending checks, and transient failures into durable queue retry with bounded backoff.
5. Preserve terminal completion for merged/closed PRs and manual review only for structured human boundaries.

## Task 5: Recover historical false terminal records safely

**Files:**
- Modify: `src/core/loop/repository-review-queue.ts`
- Create or modify: `src/core/loop/repository-review-recovery.ts`
- Test: `tests/loop/repository-review-queue.test.ts`
- Test: `tests/loop/repository-review-service.test.ts`

1. Add `retryEpoch`, progress metadata, and an idempotent terminal-reopen operation to queue records.
2. Reopen only `manual-review`/`dead-letter` items whose final summary lacks a valid human boundary and whose PR remains open.
3. Skip recovery when a newer or active occurrence exists for the same repository, or when an active WorkOrder/lease already owns the occurrence.
4. Reset the bounded attempt budget by incrementing `retryEpoch`; retain the prior terminal status/reason as migration evidence.
5. Run migration from the repository-review service path before leasing ready work and prove restart idempotency.

## Task 6: Align operator visibility and governance

**Files:**
- Modify: `src/core/dashboard/runtime-overview-reader.ts`
- Modify: `src/core/dashboard/runtime-overview.ts`
- Modify: `docs/automation-alignment.md`
- Modify: `docs/intelligent-automation.md`
- Modify: `docs/agent-maintenance-guidelines.md`
- Test: `tests/core/runtime-overview-reader.test.ts`
- Test: relevant documentation contract tests

1. Surface Repository PR Review retry, system-repair, true manual boundary, and dead-letter states distinctly in Runtime Overview.
2. Document the structured human-boundary invariant, safe workflow-policy envelope, recovery migration, and action evidence.
3. Add contract assertions so future prose-only manual classification or unsafe private-fork settings fail locally.

## Task 7: Verify, commit, and close the live incident

1. Run focused tests after each red/green slice.
2. Run source/test type checks, Biome on touched files, dependency-cruiser, documentation contracts, and `git diff --check`.
3. Run `npm run verify:local` and inspect the complete exit status.
4. Re-observe `OctopusGarage/fluent-frame#22`, execute only the controller-approved repair, and enqueue/reopen exactly one review occurrence if it remains open.
5. Confirm the queue/WorkOrder state is retryable or completed and no duplicate worker exists.
6. Commit the completed slice on `dev`; do not push unless separately requested.
