# Automation Architecture Deepening Design

## Goal

Deepen three related automation modules without changing the managed-project
ownership rules: recovery admission, system-gate findings, and cross-chat
presentation policy.

## 1. Recovery Admission

`RecoveryAdmission` is the single module that turns structured recovery
findings into durable repair-queue lifecycle transitions. Its interface accepts
findings and a dispatch adapter, then owns deduplication, priority, leases,
immediate deferral, repair-status mutation, and authoritative closure.

Daily Task Audit, Runtime Guardian, and Project Recovery remain adapters. They
discover their own evidence and translate it into the shared finding shape; they
do not claim queue records or mutate repair lifecycle state directly. The
existing `RepairCoordinator` remains the persistence implementation behind the
new module. Existing ledger data is converted at the adapter seam, so historical
records remain auditable and no state is discarded.

## 2. Structured System Gate Findings

The system-gate module will write a stable structured finding list rather than
making downstream modules infer repairability from failure strings. A finding
contains a code, repair disposition, retry policy, evidence, and human display
text. Execution-worktree, git, pull-request, CI, and supervisor checks produce
these findings at their source.

`system-gate.json` keeps the existing string arrays for backwards-compatible
human reports while adding the structured list. Runtime Guardian consumes only
the structured list when it is present. Legacy artifacts without it are treated
as repairable investigation work rather than terminalized by text matching.

## 3. Presentation Policy

The Telegram and Lark adapters have two real implementations, so a seam is
justified only for the shared notification intent. A small core presentation
module will turn task-audit and recovery notification intent into a channel-
neutral content model. Each adapter retains its own implementation for Markdown
or Lark cards, transport retries, and channel-specific actions.

This preserves ADR-0002: core never imports an adapter, and no speculative
channel abstraction is introduced for unrelated interactive UI behavior.

## Error Handling and Verification

All new contracts are additive and validate unknown values as legacy data.
Every lifecycle transition is tested through the new module interface. System
gate tests prove that changed display wording cannot change repair disposition.
Adapter tests prove equivalent notification intent produces equivalent channel-
neutral content without forcing visual parity between Markdown and cards.

## Delivery Order

1. Recovery Admission with compatibility adapters.
2. Structured system-gate findings, migrated producers and Guardian reader.
3. Shared notification intent for Daily Audit and Runtime Guardian.

Each slice is independently verified and committed. No live configuration,
user state, project list, or target repository is changed.
