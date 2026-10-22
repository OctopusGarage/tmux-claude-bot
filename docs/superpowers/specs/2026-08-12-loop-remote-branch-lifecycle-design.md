# Loop Remote Branch Lifecycle Design

## Problem

Loop Engineering publishes bot-owned `loop/<project>/...` branches and opens
pull requests, but the branch lifecycle currently ends at PR merge/close and
local worktree cleanup. GitHub repository settings may leave merged branches in
place, `gh pr merge --auto` does not request branch deletion, and the worktree
cleaner intentionally knows nothing about remote refs. The result is a durable
remote-branch leak even after the PR and WorkOrder are terminal.

## Outcome

Every bot-owned remote branch has an explicit lifecycle owner. Normal merges
use GitHub's delete-on-merge setting. A bounded Loop reconciliation module is the
recovery authority for historical residue and failures between PR terminalization
and branch deletion. The steady state contains only protected long-lived branches
and branches still owned by an open PR or a live WorkOrder.

## Architecture

Add a deep `LoopRemoteBranchReconciler` module. Its interface accepts bounded,
structured observations and returns a cleanup summary. Internally it owns:

- strict `loop/<project>/...` branch-name admission;
- protected/default/base/switch-back exclusions;
- exact remote head SHA and PR head SHA binding;
- terminal PR classification;
- live WorkOrder/worker-lease/supervisor-reservation exclusion;
- durable intent/outcome evidence;
- last-moment revalidation before deletion;
- idempotent handling of already-absent refs.

The module is invoked during Loop startup reconciliation and periodically from
the existing repository-review maintenance tick. Auto-merge and local worktree
cleanup remain focused on their existing responsibilities.

## Safety Contract

A remote branch is eligible only when every condition holds:

1. It belongs to the configured repository and its name matches
   `loop/<configured-project-id>/...`.
2. It is not the repository default branch, configured base/switch-back branch,
   or a protected branch.
3. Its associated PR is terminal. `MERGED` is sufficient. `CLOSED` requires a
   structured allowlisted close reason (`duplicate`, `obsolete`,
   `non-actionable`, or `invalid`) from durable supervisor evidence.
4. The PR head SHA exactly matches the current remote branch SHA.
5. No open PR uses the branch.
6. No non-terminal WorkOrder, active worker lease, or supervisor reservation owns
   the branch or WorkOrder.
7. The same facts are re-read immediately before deletion.
8. A sanitized cleanup intent is persisted before mutation and its outcome is
   persisted afterward.

The reconciler never deletes arbitrary user branches, never guesses a missing
close reason, and never treats local branch ancestry as merge evidence. Squash
merges legitimately produce a base commit that is not a descendant of the source
branch commit.

## Lifecycle And Retention

Remote branch retention and local forensic worktree retention are independent.
A terminal PR's remote ref may be deleted while a failed WorkOrder's local
worktree remains available for its configured 72-hour failure-retention window.
The local worktree cleaner continues to own that window.

## Historical Migration

The reconciler scans only configured Loop branch prefixes and uses bounded API
pages. Historical merged refs are deleted after full revalidation. Historical
closed refs without structured close evidence remain visible as blocked cleanup
findings until evidence is available; migration never infers a reason from prose.

For the current repository, GitHub `delete_branch_on_merge` is enabled after the
implementation passes local verification. Existing refs are then reconciled
through the same production controller rather than through an unguarded bulk
delete command.

## Observability

Each cleanup records repository, branch, expected SHA, PR number, action,
timestamp, and sanitized outcome. Logs summarize scanned, eligible, deleted,
skipped, and failed counts without exposing personal paths or credentials.
Repeated reconciliation is idempotent and does not recreate evidence or mutate
an already-absent branch.

## Verification

Tests cover merged cleanup, structured closed cleanup, missing evidence, open
PRs, SHA drift, protected/base/switch-back branches, foreign branch prefixes,
live WorkOrders and leases, intent-write failure, deletion failure, restart
idempotency, and bounded discovery. Final operational acceptance verifies the
GitHub setting, zero stale Loop refs, clean configured source worktrees, no new
cleanup warnings, and a clean tmux-claude-bot worktree.
