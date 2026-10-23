# Scheduled Session Messages

Status: approved and implemented.

## Goal

Allow an owner to compose a normal text instruction now and deliver it to a
specific managed tmux session at a future time. Telegram and Feishu share the
same scheduling semantics. This is one-time user input, separate from Loop
Engineering, autonomous maintenance, and recurring task configuration.

## Approach

Use a durable scheduled-message store and a small scheduler that hands due
messages to the existing per-session message queue. Channel adapters own input
and reply rendering; the core owns parsing, target identity, lifecycle and
delivery decisions.

An in-memory timer alone loses intent on restart. Reusing a recurring Loop
Engineering job introduces WorkOrder and assessment semantics that do not belong
to ordinary chat. Neither alternative is selected.

## User Interaction

### Button-first workflow

Telegram and Feishu expose **Schedule message** and **Scheduled messages** on
their existing project control/help surfaces. Creating a schedule must not require
remembering commands, tmux names, task IDs, or time syntax.

The shared workflow is: select target, compose text, choose time, review, confirm.
The current or bound project is selected initially, and its friendly label remains
visible throughout. In private chat the owner can select another eligible managed
session without changing the chat's current project. Bound groups retain their
existing target restrictions. Entering the composer never sends the text.

Time shortcuts include **In 15 minutes**, **In 30 minutes**, **In 1 hour**,
**Tomorrow at 09:00**, and **Custom date/time**. Do not select a time implicitly.
A relative shortcut freezes a due timestamp when selected; the review shows the
full date, time and timezone. If it has passed before confirmation, require the
owner to choose a new time rather than silently changing the date.

Feishu uses a native card form with a session selector where permitted, multiline
message input, and a date/time picker. Shortcut actions update the same draft.
Form submission opens the review card; only **Confirm scheduled send** creates
the durable schedule. Invalid fields show their error without discarding text.

Telegram uses inline buttons and a reply-based composer. A custom date is chosen
from a paginated calendar, followed by hour/minute controls. Common minute values
are buttons; an exact minute or full custom timestamp can also be entered by
replying to the dedicated time prompt. Multiline message text is collected only
from a reply to that draft's dedicated content prompt. Never interpret an
unrelated ordinary message as draft content or a time value.

The final review includes the target, full date/time/timezone, and text preview,
with **Confirm scheduled send**, **Edit time**, **Edit message**, and **Discard**.
Long content has a view-full-text action within platform size limits. These edit
actions change an unsubmitted draft, not a previously confirmed schedule. The
confirmation receipt offers **View details**, **Cancel scheduled send**, and
**Scheduled messages**. Lists are paginated and show target, time and status;
owner actions are buttons, not instructions to copy an internal ID.

Drafts are scoped to channel/chat/owner and have independent opaque IDs, a revision,
and a 30-minute expiry. Separate drafts and normal chat cannot overwrite one
another. Expired or stale callbacks offer a fresh composer instead of performing
an old action. Every callback passes existing channel security and ownership
checks; Feishu callback values retain signing. Telegram callback payloads contain
compact opaque references and stay within the 64-byte limit, never message bodies
or workspace paths. Repeated confirmation creates exactly one schedule and returns
the same receipt. Draft cancellation or expiry never creates a scheduled message.

### Command and CLI alternatives

Proposed chat syntax, identical in both channels:

```text
/schedule 30m Review the failing tests and explain the cause.
/schedule 18:30 Review the failing tests and explain the cause.
/schedule 2026-10-24T09:00+08:00 Review the failing tests and explain the cause.
/schedule list
/schedule show <id>
/schedule cancel <id>
```

`30m`, `2h`, and `1d` are positive relative durations. `HH:mm` means the next
occurrence in the bot host's local timezone. ISO timestamps must include a UTC
offset or `Z`. Past absolute timestamps, invalid dates, empty messages, and
ambiguous expressions are rejected. No AI interpretation of time is required.
Nonexistent or ambiguous daylight-saving wall-clock times require an explicit
offset-bearing timestamp.
The remaining message body, including line breaks, is preserved.

Creation resolves the target using the channel's normal current/bound-session
and reply routing. It snapshots that identity immediately. Switching projects
or rebinding a group later never redirects the scheduled message. A confirmation
shows the full local date, timezone, target label, content preview, and task ID,
with view and cancel actions. `/schedule` without arguments shows help and the
button-based composer/management entry points.

The local CLI exposes the same operations through the running bot:

```text
tcb schedule create --session <session> --at <offset-bearing-ISO-time> --text <text>
tcb schedule create --session <session> --in 30m --text <text>
tcb schedule list --json
tcb schedule show <id> --json
tcb schedule cancel <id>
```

Chat list/show/cancel are scoped to the creating channel, chat, and owner.
Group creation respects the existing bound-session restrictions. Local control
is an operator surface and can inspect all records. No arbitrary shell commands
are executed by the scheduler; the body is delivered as agent input.

## Time And Target Semantics

The scheduled time is the earliest delivery time, not a guarantee that the agent
starts or finishes then. A busy session follows ordinary per-session ordering.
The confirmation states that the host and bot must be running for timely delivery.

Waiting schedules survive restarts. If the host sleeps or the service is down,
unstarted overdue messages are sent when it becomes available again, provided
the pinned target incarnation is still valid. The receipt
records both the scheduled and actual delivery times. There are no new wake
events, privileges, keep-awake assertions, or host sleep changes.

A schedule targets a concrete managed tmux session incarnation, not merely a
reusable display name. Pin the managed session name, canonical workspace identity
when present, and tmux server/session incarnation evidence. Deleting/recreating
the session, reusing an independent slot, or changing its workspace blocks the
schedule and notifies its owner. The scheduler does not silently create an agent
or redirect the message. A bot-only restart can recover unchanged live targets;
a host/server restart that invalidates incarnation evidence requires a new schedule.

Scheduled input retains ordinary user-message readiness, conflict and resource
checks. It is not converted to system input or admitted through autonomous repair
gates. Remote authorization occurs when the schedule is created or managed;
expiry of an ingress grant does not revoke already admitted input, matching the
existing security contract.

## Delivery Lifecycle And Restart Safety

Persist records under the application state directory with a versioned schema,
stable schedule ID, creation request ID, original/prepared text, target snapshot,
origin channel/chat/owner, reply destination, due time, timezone, timestamps and
structured lifecycle evidence. Do not log message bodies or copy live schedules
into source-controlled configuration. Corrupt or unreadable state fails closed.

The core owns these states:

- `scheduled`: durable intent; not yet eligible or not yet handed off.
- `queued`: accepted into the in-memory session queue, still cancellable.
- `sending`: an atomic durable claim exists immediately before the tmux write.
- `sent`: tmux input submission returned successfully; agent completion is separate.
- `blocked`: a known target/readiness issue prevented submission.
- `failed`: a known permanent preparation or delivery error.
- `cancelled`: cancellation won before the submission claim.
- `uncertain`: interruption or error left submission outcome unknown.

The existing queue does not replay Telegram/Feishu messages after restart. Keep
that rule. Recover only this feature's durable unstarted records and use the
stable schedule ID to avoid duplicate in-memory handoffs. Prepare translation
once before queue admission and persist its result before any tmux write.

Add narrow optional delivery lifecycle hooks at the shared dispatcher boundary.
The durable claim must succeed after readiness checks and immediately before
`bridge.sendKeys`; cancellation and claim compete through one atomic store
transition. Revalidate the pinned target at that boundary. A successful tmux write
marks `sent` before waiting for the agent response. Ordinary queue callbacks keep
their current response behavior.

Recover `scheduled` and unclaimed `queued` records after restart. Never replay
`sent` or unresolved `sending` records automatically. An interrupted write becomes
`uncertain`, visible to the owner. Exactly-once execution across a tmux write and
a filesystem transaction is not promised. A notification failure cannot cause
the instruction to be resent. Duplicate platform events reuse their creation
request ID; two intentional schedules containing identical text remain distinct
and are not discarded by ordinary text deduplication.

Queue-full deferrals retain durable intent with bounded retry backoff. Concurrent
ticks cannot hand off the same schedule twice. Cancellation commits the durable
decision first and removes the in-memory item if it is still queued. A dequeued
item that is waiting for readiness must also honor that decision at the final
submission claim. Once submission has been claimed, cancellation reports that it
is no longer available. Blocked, failed and
uncertain records are inspectable and cancellable but are not silently resent.

## Implementation Boundaries

- New `src/core/scheduled-messages/` modules own validated records, time parsing,
  atomic storage transitions, service lifecycle and the shared command facade.
- `src/core/command/queue-message.ts`, `queue.ts`, and `dispatch.ts` gain only the
  optional identity/dedupe and submission lifecycle seams required for delivery.
- Bootstrap/index start one scheduler after reply transports are registered and
  stop it during shutdown. Adapters register delayed reply senders; captured
  request-context closures are not persisted.
- Telegram and Lark add thin command/card handlers backed by the shared facade.
  Shared draft validation and lifecycle remain in the core; native form and
  inline-keyboard rendering remain in their adapters. Reply prompts carry draft
  identity so composing a scheduled message does not capture ordinary chat.
  The control protocol and CLI call that same facade rather than editing files.
- Update help catalogs, all supported i18n catalogs, CLI/chat manuals, the usage
  guide and the relevant automation alignment/capability documentation together.
- No dedicated TUI editor, new MCP tools, recurrence, scheduled images/voice,
  arbitrary key actions, or message editing in the first version. Cancel and
  recreate is the initial rescheduling workflow.

## Acceptance Evidence

Tests must cover time/offset parsing, malformed and past timestamps, no early
delivery, pinned-session routing after project switches, repeated identical
intentional content, duplicate ingress events, busy/full queues, permission
boundaries, cancelled/claim races, concurrent ticks, translation preparation,
bot restart recovery, replaced targets, tmux write ambiguity, and notification
failures. Run both channel command/card tests against the shared behavior.
Also exercise the complete button workflow, draft expiry, field validation,
back/edit actions, unchanged chat routing, unrelated-message isolation, group
target restrictions, stale/cross-owner callbacks, callback payload size limits,
calendar month boundaries and repeated confirmation.

Use an isolated real tmux session to verify the instruction reaches the selected
pane only after the due time, once, with its multiline body preserved. Never send
smoke-test instructions to an owner's live session. Run `pnpm verify:local` and
the normal commit/push gates before publishing the implementation.

## Platform References

- Feishu date/time picker:
  <https://open.feishu.cn/document/feishu-cards/card-components/interactive-components/date-time-picker>
- Feishu form container:
  <https://open.feishu.cn/document/feishu-cards/card-components/containers/form-container>
- Telegram inline keyboards and reply prompts:
  <https://core.telegram.org/bots/api#inlinekeyboardmarkup>
  <https://core.telegram.org/bots/api#forcereply>
