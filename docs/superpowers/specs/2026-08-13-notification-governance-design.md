# Notification Governance Design

Date: 2026-08-13
Status: Approved

## Objective

Reduce proactive notification volume without hiding failures that require an
operator decision. Notifications should be concise, stateful across service
restarts, and reserved for user-requested results or actionable automation
events. Runtime Overview, bounded CLI history, logs, ledgers, and reports remain
the complete diagnostic surfaces.

## Product Policy

Notifications follow four semantic classes:

1. `interactive-result`: a result for work explicitly requested by the user.
   Deliver once when the result becomes terminal.
2. `action-required`: an automation failure, safety boundary, or degraded state
   the bot cannot close itself. Deliver on first observation, material
   escalation, and recovery after a delivered alert.
3. `autonomous-success`: successful unattended work. Persist and expose it in
   observability surfaces without proactive delivery.
4. `informational-state`: expected environmental or intermediate state. Keep it
   in status/history and do not proactively deliver it.

The default source behavior is:

- Host Power: battery operation is informational. A broken wake schedule,
  keep-awake acquisition failure, or failed safety probe is actionable. The
  same power problem is delivered at most once per quiet-window cycle and is
  durable across service restarts.
- Daily Task Audit: an all-clear audit is silent. Unresolved active issues are
  actionable; repaired, closed, or already-owned findings remain in the audit
  view without another notification.
- Resource Guardian: elevated pressure and internal sampling phases are status
  evidence. Entry into critical/emergency pressure, an exhausted safety hold,
  or an action failure is actionable. Recovery is delivered only when the
  preceding unhealthy state produced an alert.
- Agent Capacity: exhaustion and subsequent recovery are state transitions.
  Identical observations remain silent across restarts.
- Long Task Monitor: ordinary interactive project-session tasks retain one
  completion result. Loop, Autopilot, repair, audit, and supervisor WorkOrders
  rely on their domain terminal result and are excluded from the generic
  completion path.
- Autopilot and other domain completion: user-requested results remain visible;
  successful unattended work is silent. Failures that the repair lifecycle
  already owns are not separately escalated unless they become terminal and
  require operator action.
- Opportunity Discovery: a digest with genuinely new suggestions remains a
  user-facing result. Existing store deduplication remains authoritative.
- Crash recovery: one crash identity produces one owner alert, routed to one
  preferred channel with fallback instead of independent per-adapter alerts.
- Explicit `tcb notify`: remains an always-send operator command and is not
  governed as autonomous noise.

## Architecture

### Notification delivery policy

`NotificationRequest` gains optional structured delivery metadata:

- a stable topic key;
- the current semantic state or occurrence identity;
- a delivery mode (`always`, `state-change`, or `once-per-window`);
- an optional window identity for naturally recurring checks.

Requests without metadata preserve explicit/manual send behavior. Bot-owned
producers must declare their semantics. The gateway applies policy before
channel delivery and returns an explicit suppressed result when every requested
delivery is intentionally silent.

### Durable notification state

A notification policy store lives under the canonical application state
directory. It records only bounded, non-secret delivery evidence:

- topic;
- state/occurrence fingerprint;
- channel;
- last successful delivery time;
- whether a delivered unhealthy state still awaits a recovery notification.

State is written only after successful channel delivery. Partial delivery is
tracked per channel so a failed channel can retry without duplicating a channel
that already succeeded. Records are bounded by count and retention. Corrupt
state fails open for actionable delivery and is replaced atomically; it must
never suppress a safety alert.

### Rendering

The notification source remains structured metadata for routing and audit but
is no longer rendered as a visible `source:` line. Default text is:

```text
<icon> <short title>
<one concise fact or action, when needed>
```

Routine messages should not expose incident IDs, circuit names, run IDs, raw
paths, or internal phase names. Those values stay in structured evidence and
diagnostic surfaces. An operator command is included only when it can resolve
the condition.

### Producer decisions

Producer modules own the domain decision about whether an event is interactive,
actionable, autonomous success, or informational. The gateway owns durable
deduplication, per-channel delivery, and concise shared formatting. This keeps
domain meaning out of the transport while preventing each producer from
reimplementing restart-safe cooldown logic.

## Failure Handling

- Failed delivery does not advance the durable suppression state.
- A partially successful multi-channel delivery records only successful
  channels and retries the failed channel later.
- Persistence failure never suppresses an actionable notification; delivery
  proceeds and the failure is logged.
- Notification suppression never changes task, repair, ledger, or system-gate
  settlement.
- Recovery messages are emitted only when the corresponding unhealthy alert was
  successfully delivered.

## Verification

Contract tests must prove:

- identical state is suppressed across a newly constructed gateway;
- state changes and occurrence/window changes deliver again;
- failed and partial deliveries remain retryable per channel;
- corrupt policy state fails open;
- `source:` is absent from rendered text while source metadata is preserved;
- battery-only power state is silent while actionable power failures alert once
  per quiet cycle;
- healthy Daily Task Audit runs are silent;
- non-actionable Resource Guardian transitions are silent and alert recovery is
  paired with a delivered unhealthy state;
- automation sessions do not also produce generic Long Task notifications;
- one crash identity routes through the shared gateway only once;
- explicit operator notifications continue to send every time.

The slice must update automation alignment, capability documentation, and
maintenance guidance, then pass `npm run verify:local`.
