# Loop Remote Branch Lifecycle Implementation Plan

**Goal:** Ensure every terminal Loop Engineering PR relinquishes its bot-owned
remote branch safely and durably, including historical residue and restart gaps.

**Architecture:** A new reconciliation module owns branch eligibility,
revalidation, mutation evidence, and deletion. Loop service composition supplies
GitHub observation/mutation and live WorkOrder ownership. GitHub's native
delete-on-merge setting handles the normal path; reconciliation is the durable
fallback.

**Tech Stack:** TypeScript, Vitest, GitHub CLI/API, existing Loop WorkOrder
registry and JSON state primitives.

## Task 1: Policy And Evidence Contract

- [ ] Add tests proving only exact configured `loop/<project>/...` terminal PR
      heads are eligible.
- [ ] Add tests for protected/base/switch-back exclusions, SHA drift, open PR,
      missing closed evidence, and live WorkOrder ownership.
- [ ] Implement the pure cleanup planner and typed observations.
- [ ] Add a bounded sanitized intent/outcome store with restart lookup.

## Task 2: Account-Bound GitHub Adapter

- [ ] Add red tests for bounded branch discovery, exact PR/head reads,
      last-moment revalidation, and delete-by-exact-ref behavior.
- [ ] Implement configured-account GitHub commands without exposing tokens.
- [ ] Treat an already-absent exact ref as idempotent success.

## Task 3: Reconciliation Controller

- [ ] Add red tests proving intent-before-delete, no delete on intent failure,
      outcome persistence, stale-plan refusal, and restart idempotency.
- [ ] Implement one bounded reconciliation pass with explicit counters.
- [ ] Keep local worktree retention independent of remote-ref eligibility.

## Task 4: Service Integration And Alignment

- [ ] Add service tests for startup and periodic reconciliation composition.
- [ ] Wire the reconciler through Loop startup and repository-review maintenance.
- [ ] Update automation alignment, intelligent automation, and maintenance docs.

## Task 5: Verification And Deployment

- [ ] Run focused tests, both TypeScript checks, Biome, dependency-cruiser, and
      `git diff --check`.
- [ ] Run `npm run verify:local`.
- [ ] Commit the implementation.
- [ ] Enable GitHub `delete_branch_on_merge` for the target repository.
- [ ] Run the production reconciler over historical refs.
- [ ] Verify zero stale Loop remote refs, clean source worktrees, clean service
      logs, and a clean tmux-claude-bot worktree.
