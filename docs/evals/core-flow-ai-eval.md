# Core Flow AI Eval

Date: 2026-07-14

## Scope

This eval reviews the core behavioral flows after the recent routing, session, notification,
and dashboard refactors. It is intentionally focused on hidden bug risks rather than raw line
coverage.

## Rubric

Pass criteria:

- Message routing cannot drift between Telegram and Lark.
- A stale or legacy session name cannot cause input to be pasted into a missing tmux target.
- Long-task completion notifications fire only for a single long task, not accumulated short tasks.
- Notification target selection uses the most recent owner channel and falls back only on failure.
- Notification target selection never picks a bound Lark group when the Lark notification channel is
  not registered.
- Session reply targets prefer the latest stored channel but fall back to a bound Lark group after
  the stored target is cleared.
- Lark group bindings survive module reloads, list in stable chat-id order, and resolve the group
  bound to a session.
- Local send-only notifications preserve structured fields across the control socket, including
  multiline bodies and session metadata.
- Pane animation detection treats changing panes as active and static or unreadable panes as idle.
- Reply-target persistence remains bounded across restart, even if an older backing file already
  exceeds the configured cap.
- Dashboard/activity state is derived from shared snapshots, not duplicated local rules.
- CLI smoke entry points parse after build without touching production state or external chat APIs.

## Evidence

- Unit suite: `npm test`
- Coverage suite: `npm run test:coverage`
- Type/test type checks: `npm run lint:types`, `npm run lint:types:tests`
- Dependency rules: `npm run depcruise`
- Build: `npm run build`
- Smoke: `npm run smoke`

## Findings

### Pass: Cross-Channel Action Parity

Telegram and Lark action routing now derive from `src/core/command/action-registry.ts`.
The parity tests cover immediate-vs-queued action classification and protect against drift
such as one channel enqueueing an action that the other runs immediately.

### Pass: Legacy Session Alias Safety

The `.alcove` hidden-directory failure is covered at three levels:

- `sessionNameFromPath()` sanitizes tmux target separators.
- `resolveLiveSessionName()` prefers exact live sessions and falls back to sanitized aliases.
- Adapter and dispatch tests verify stale persisted names are remapped before sending input.

### Pass: Long-Task Notification Semantics

The monitor tests cover the main hidden-bug cases:

- No notification work when no channels are registered.
- Notify once when a long task completes.
- Do not infer long tasks from cumulative busy time.
- Do not combine several short tasks into one long task.
- Notify a completed armed task when another task starts immediately.
- Prefer the recent owner channel and fall back after delivery failure.
- Prefer a bound Lark group only when the Lark notification channel is registered.

### Pass: Local Notification Control Socket

`tests/adapters/control/server-ops.test.ts` covers `ControlClient.notify()` over the real unix
socket. It verifies multiline bodies and session metadata survive the protocol/server dispatch
boundary before reaching `NotificationGateway`, and attachment requests are routed through the same
gateway path.
`tests/core/notifications/gateway.test.ts` covers partial notification results when the text body is
delivered but attachment delivery cannot proceed because the selected channel has no attachment
sender or because attachment validation fails before upload.
`tests/core/pane-activity.test.ts` covers the shared pane-animation signal used by dashboard busy
state and prompt idle-gating: changing pane captures are active, while static panes and capture
failures are idle.
`tests/bounded-session-map.test.ts` now covers restart loading of an oversized reply-target backing
file: construction trims oldest entries back to the configured cap and persists the trimmed state, so
stale message-id mappings cannot grow unbounded after a service restart.
`tests/core/projects/session-reply-target.test.ts` covers stored reply targets, Lark group fallback,
no-target null behavior, and the group-fallback path after clearing a stored target.
`tests/unit/core/group-bindings.test.ts` covers group binding read/list/unbind behavior, session
reverse lookup, stable list ordering, and persistence across module reloads.

### Watch: Adapter Handler Branch Coverage

Lark and Telegram handler/card-action files remain lower coverage than pure core modules
because they multiplex many UI commands. The core decisions behind those branches are now
extracted and covered by focused unit tests where practical. Do not chase 100% adapter line
coverage unless a branch owns business logic rather than UI dispatch.

### Watch: Live/Interactive Scripts

`src/scripts/claude-tmux.ts` and onboarding wizards are intentionally not covered by full
unit tests because they create tmux sessions or require human/chat setup. The smoke script
now covers built CLI parsing safely; live workflows should stay behind explicit manual or
environment-gated tests.

## Result

No new hidden bug was found in the reviewed core flows after the session alias fix. The main
remaining risk is not missing pure core coverage; it is interactive adapter/script behavior
that should be protected by smoke/manual-gated tests rather than broad mocks.
