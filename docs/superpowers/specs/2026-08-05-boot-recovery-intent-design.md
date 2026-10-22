# Boot Recovery Intent Design

## Problem

Boot recovery currently treats the persisted `running_sessions` roster as
proof that a project has unfinished work. The roster is also used to remember
which agent sessions existed before a reboot, so an idle project can survive
in the roster indefinitely. On startup, recovery then sends `resume` to that
project. This creates a new agent turn with no user task and can trigger a
misleading `long-task-monitor` completion notification.

## Goals

- Automatically resume only work with durable evidence that it was unfinished
  when the bot or machine stopped.
- Preserve the existing session roster for diagnostics and explicit/manual
  recovery.
- Never replay an old user chat message merely because a project session was
  previously running.
- Make the reason for every automatic recovery decision observable.
- Keep recovery idempotent across repeated launches and partial failures.

## Non-goals

- Changing the manual `/recover` behavior.
- Inferring unfinished work from transcript age, last-use time, or process
  presence alone.
- Replacing the existing queue persistence model.
- Changing notification wording or disabling legitimate long-task notices.

## Design

Introduce a small durable per-session recovery-intent store. An intent is
created when a queued prompt is admitted for execution and is removed after
that task reaches a terminal outcome. The record contains a stable
task/message identifier and creation time. Writes are atomic through the shared
JSON-map state store; a missing or malformed state file is treated as empty
while the store preserves a corruption backup.

The existing persisted queue continues to restore eligible system-owned
messages that were still queued. Boot agent recovery itself uses the
recovery-intent store to identify prompts that had already been dispatched but
did not reach a terminal outcome before shutdown.

`running_sessions.json` remains a runtime roster only. It must not authorize an
automatic `startWithResume`. Boot `planRecovery` will produce a launch action
only when a recovery intent exists. A roster entry without that signal is
classified as idle and is skipped by boot auto-recovery.

Manual recovery keeps its existing explicit semantics and may still recover
rostered projects on operator request.

The recovery log event will include `reason` and `taskId` when applicable. An
idle roster entry will be logged as skipped rather than recovered. The
long-task monitor remains unchanged; because idle sessions are no longer
started by boot recovery, it cannot observe a synthetic `resume` turn.

## Lifecycle and failure handling

- Create intent when dispatching work, so a crash during the handler or agent
  startup is recoverable.
- Clear the intent only after the queue handler reaches its terminal callback,
  using the task id so an older task cannot clear a newer one.
- On startup, recover an intent at most once per live session. Clear it after
  the recovery dispatch is accepted; if dispatch fails, retain it for a later
  boot and report the failure.
- Bound the store to one active intent per session. New work supersedes only a
  terminal intent, never an active one.

## Verification

Focused tests will cover:

- an idle persisted roster entry is skipped;
- an in-flight recovery intent authorizes recovery;
- malformed state is safe and observable;
- repeated planning is idempotent;
- manual recovery remains unchanged;
- a recovered task does not produce a synthetic long-task completion.

The change must pass the focused test suite and `npm run verify:local`.
