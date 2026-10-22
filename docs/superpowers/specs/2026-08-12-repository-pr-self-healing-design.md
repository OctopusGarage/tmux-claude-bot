# Repository PR Self-Healing Design

## Goal

Make repository-wide pull-request review close every ordinary automation loop
without operator intervention. The system must repair bounded conflicts and
GitHub Actions admission problems, retry transient states, merge safe changes,
or close evidence-backed obsolete work. It may retain `manual-review` only when
trusted platform evidence proves that an owner decision or unavailable
authority is genuinely required.

This design extends the structured decision and durable queue contract in
`2026-08-07-repository-pr-auto-resolution-design.md`. It addresses the remaining
gap exposed by a private same-repository Dependabot PR whose workflow runs ended
as `action_required`: the supervisor described the state as a permission
boundary, the string-based final-summary classifier accepted that claim, and
the queue permanently terminalized a repairable occurrence.

## Non-goals

- Do not bypass required CI, review, mergeability, or system gates.
- Do not grant fork workflows write tokens or repository secrets.
- Do not mutate external-fork branches.
- Do not generalize this into an unrestricted GitHub settings editor.
- Do not make model-provider API calls; review judgment remains in the active
  Claude Code or Codex worker.
- Do not reopen product, migration, security-design, legal, compliance, or
  proven authority boundaries automatically.

## Invariants

1. Supervisor prose is review evidence, not authorization truth.
2. GitHub identity, repository permission, PR ownership, workflow-run state,
   and Actions policy are read through the configured `githubAccount` and are
   authoritative for deterministic disposition.
3. `action_required`, pending checks, Draft state, merge conflicts, branch
   drift, inconclusive mergeability, and transient GitHub failures are never
   terminal human decisions by themselves.
4. Automatic settings repair is allowed only for a private repository, a
   same-repository Dependabot PR, and a configured actor with repository admin
   permission.
5. Settings repair may enable fork-PR workflow execution but must keep both
   write tokens and secrets disabled.
6. Queue completion still requires every in-scope PR to be merged or closed
   with an allowlisted, evidence-backed reason.
7. Every external mutation is idempotent, persisted, and revalidated against
   the current repository, PR number, and head SHA immediately before use.
8. A newer active occurrence for the same repository owns recovery; migration
   must not create two concurrent repository reviewers.

## Architecture

### System-owned resolution module

Add an internal repository-review resolution module between supervisor summary
parsing and queue settlement. It consumes:

- the configured repository identity and GitHub account;
- the WorkOrder and structured per-PR decisions;
- trusted GitHub observations supplied by an injected adapter; and
- durable records of previously attempted recovery actions.

It returns a discriminated result:

- `completed`: all PRs are merged or allowlist-closed;
- `retry`: the state is transient, repairable, incomplete, or changed;
- `manual-review`: trusted evidence proves a real human boundary; or
- `repair`: one or more exact, allowlisted deterministic actions must execute
  before disposition is evaluated again.

The module owns policy and state transitions. The GitHub adapter owns command
execution and response parsing. Loop service remains the coordinator that runs
the resolution, persists action evidence, and settles the queue.

### Trusted GitHub observation

For every unresolved PR, the adapter reads a bounded snapshot through the
WorkOrder's configured account:

- authenticated actor login;
- actor repository permission;
- repository visibility and owner;
- PR state, base/head repositories, base/head refs, author, Draft state,
  current head SHA, mergeability, and merge-state status;
- current-head check rollup and workflow runs;
- private-repository fork workflow settings when applicable; and
- branch protection or API refusal evidence when available.

Commands must use the existing managed GitHub-account boundary. A repository or
head-SHA mismatch aborts the action and returns to retry; the implementation
must not guess from the current shell repository.

### Manual-review evidence

Replace keyword matching as the future authority boundary. A supervisor may
request `manual-review`, but the system accepts it only when structured trusted
evidence yields one of these codes:

- `external-fork-write-unavailable`;
- `repository-permission-insufficient`;
- `protected-branch-policy-denied`;
- `organization-actions-policy-denied`;
- `product-decision-required`;
- `migration-decision-required`;
- `security-design-decision-required`;
- `legal-or-compliance-decision-required`.

The first four require GitHub/API evidence. The latter four remain worker
judgments, but must carry the exact question and next owner action rather than a
generic request to inspect code. Unsupported or contradictory claims normalize
to `retry`.

### `action_required` recovery

When current-head workflow runs are `action_required`, execute this state
machine:

1. Re-read PR identity, head SHA, actor, permission, and workflow run.
2. If the run supports the GitHub workflow-run approval endpoint, approve it
   once and persist the run ID and response.
3. If approval is unsupported and all strict eligibility conditions below hold,
   read the private-fork workflow policy and update it to exactly:

   ```text
   run_workflows_from_fork_pull_requests = true
   send_write_tokens_to_workflows = false
   send_secrets_and_variables = false
   require_approval_for_fork_pr_workflows = false
   ```

4. Re-read the policy and fail closed unless those exact safe values are
   observed.
5. Trigger a fresh PR synchronization through the normal branch-update or
   bounded conflict-repair path. A plain rerun is insufficient when GitHub
   preserves the original Dependabot security context.
6. Poll with a bounded timeout. New pending runs return `retry`; failed runs
   enter the existing bounded repair flow; passing runs continue to the two
   review passes and merge gate.

Strict eligibility for settings repair requires all of:

- the repository is private;
- the configured actor has repository `admin` permission;
- the PR author is Dependabot;
- head and base repositories are the configured repository;
- the affected workflow run belongs to the current head SHA; and
- current settings do not already expose write tokens or secrets.

Any mismatch blocks the mutation. Organization-policy refusal with verified
repository-admin authority is a structured manual boundary because the
configured actor cannot repair it. Network errors and inconclusive API replies
remain retryable.

### Conflict and branch-drift recovery

For a same-repository PR with bounded conflict or branch drift, the worker takes
over the existing head branch in its isolated WorkOrder repository, verifies
the configured git toplevel, synchronizes the configured base, resolves the
conflict, verifies the resulting diff, and pushes the same head branch. The
system then re-reads the head SHA, checks, and mergeability before accepting a
decision.

If the PR is demonstrably duplicate, obsolete, non-actionable, or invalid, it
may be closed with the existing allowlisted reason and evidence. Conflict, age,
or CI state alone never authorizes closing.

## Durable action evidence

Persist repository-review recovery actions in a bounded store keyed by
repository, PR number, head SHA, action kind, and target run or policy version.
Each record contains:

- the configured GitHub account and observed actor;
- precondition evidence and observation time;
- action kind and exact safe target state;
- started and terminal timestamps;
- success, retryable failure, or authority-denied outcome; and
- a redacted error summary.

Never persist credentials, workflow logs, absolute local paths, or arbitrary
command text. A restart consults this evidence before acting, re-reads GitHub,
and either confirms the prior effect or resumes from the next safe state.

## Queue migration and retry semantics

Historical `manual-review` or `dead-letter` records may be reopened once when
their matching final summary shows only legacy repairable evidence such as
`action_required`, pending checks, ordinary conflicts, Draft state, branch
drift, or transient worker failure.

The migration must:

- locate the matching WorkOrder and structured PR decisions;
- confirm at least one referenced PR is still open;
- refuse migration when any genuine human-boundary evidence remains;
- prefer an already active newer occurrence for the same repository;
- otherwise move the record to `retry-wait`, clear stale leases, reset the
  infrastructure-attempt budget, and mark the migration version and reason;
- retain the original occurrence ID, WorkOrder ID, prior status, attempt count,
  and timestamp for audit; and
- run idempotently across restarts.

Attempts measure repeated work without progress. A trusted change in head SHA,
workflow state, successful recovery action, or newly available authority is
progress and starts a fresh bounded retry epoch. Identical observations retain
the existing exponential backoff and attempt budget. This prevents both
infinite hot loops and permanent dead-lettering after the system gains a new
repair capability.

## Data flow

```text
scheduled/reopened repository queue item
  -> isolated repository review WorkOrder
  -> supervisor review + provisional per-PR decisions
  -> system-owned GitHub observation
  -> deterministic resolution
       -> repair action -> persist -> re-observe -> resolve again
       -> retry         -> retry-wait with bounded backoff
       -> manual        -> terminal only with trusted boundary evidence
       -> complete      -> merged/allowlist-closed only
  -> system gate + report + ledger + notification
```

## Error handling

- Observation or mutation timeout: `retry` with bounded backoff.
- Authentication mismatch or missing configured account: structured
  configuration/authority boundary; do not fall back to the active default
  account.
- PR closed or merged while processing: re-read state and settle from current
  evidence rather than replaying a mutation.
- Head SHA changes: invalidate prepared actions and restart observation.
- Partial settings write: re-read all four values; continue only if the exact
  safe state is observed, otherwise fail closed.
- CI failure: route to the existing bounded repair path; do not reinterpret it
  as Actions admission failure.
- Resource Guardian or project conflict denial: retain queue ownership and
  retry; do not consume an external-mutation attempt.
- Repair budget exhaustion without a human boundary: remain a visible
  dead-letter eligible for state-change reactivation, never masquerade as
  `manual-review`.

## Alignment and operator visibility

Update `docs/intelligent-automation.md` and `docs/automation-alignment.md` in the
implementation slice. Repository review reports and the runtime overview must
distinguish:

- retrying a transient state;
- applying or awaiting an automatic GitHub repair;
- blocked by a verified human boundary;
- dead-lettered after unchanged bounded attempts; and
- merged or evidence-backed closed.

No general-purpose operator command is required for the repair itself. Existing
status/report surfaces must expose the structured disposition, last safe action,
next retry, and redacted reason so operators can audit the automation without
editing state files.

## Verification

Implementation follows test-driven development. Required regression coverage:

1. repository admin plus `action_required` cannot become `manual-review`;
2. successful single-run approval is idempotent;
3. eligible private same-repository Dependabot policy repair writes and verifies
   only the four safe values;
4. write-token or secret exposure is never enabled and unsafe existing settings
   fail closed;
5. non-admin, external-fork, organization-policy, product, migration, and
   security-design boundaries classify correctly;
6. pending and failed post-repair checks return to their correct paths;
7. same-repository conflicts enter bounded repair rather than terminal manual
   review;
8. legacy repairable `manual-review` and `dead-letter` records reopen once,
   while genuine human decisions remain terminal;
9. migration and action execution remain idempotent across restart;
10. head-SHA changes invalidate stale actions;
11. a newer repository occurrence prevents duplicate recovery workers; and
12. service, final-summary, prompt, docs, report, and alignment contracts agree.

Focused tests must pass before the full `npm run verify:local` gate. A live
acceptance check then lets the normal system re-observe the affected PR and
demonstrates one of the valid terminal outcomes: merged, evidence-backed closed,
or a trusted and explicitly coded human boundary. The acceptance check must not
edit durable queue files by hand.
