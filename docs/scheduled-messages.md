# Scheduled Session Messages

Compose an instruction now and submit it to a selected managed tmux session at a
future time. Telegram and Feishu/Lark provide **Schedule message** and
**Scheduled messages** buttons on their control/help surfaces. No cron or Loop
Engineering configuration is required.

## Button Workflow

1. Open **Schedule message**. The current/bound session is selected initially.
   Private chats can select another eligible session without switching the chat.
2. Enter the instruction. Telegram uses a reply to a dedicated content prompt;
   Feishu uses a multiline card form. Ordinary chat remains ordinary chat.
3. Choose **In 15 minutes**, **In 30 minutes**, **In 1 hour**, **Tomorrow at 09:00**,
   or a custom date/time. Telegram offers a calendar and time controls; Feishu
   offers its native date/time picker.
4. Review the target, full date/time, timezone and content. **Confirm scheduled
   send** creates the schedule. Drafts do not send instructions and expire after
   30 minutes. Edit or discard them before confirming.
5. Open **Scheduled messages** to inspect delivery state or cancel an unsubmitted
   instruction. Long content has a paginated full-text view.

Bound groups retain their normal target restrictions. Owners can manage only
their own schedules in that channel/chat. Local CLI access is operator-wide.

## Chat Commands

```text
/schedule
/schedule 30m Review the failing tests and explain the cause.
/schedule 18:30 Continue reviewing this change.
/schedule 2026-10-24T09:00+08:00 Review the failing tests.
/schedule list
/schedule show <id>
/schedule cancel <id>
```

Positive delays use `m`, `h` or `d`. `HH:mm` means the next occurrence in the
bot host's local timezone. Absolute timestamps require `Z` or a numeric UTC
offset. The confirmation always states the exact date and timezone. Invalid,
ambiguous daylight-saving and past absolute times are rejected. A relative
shortcut freezes its timestamp when selected; an expired time requires a new
selection before confirmation. Message bodies preserve their line breaks.

## Local CLI

The CLI talks to the running bot; it does not edit state files or spawn another
service. Session names or unique friendly session labels are accepted.

```sh
tcb schedule create --session example-project --in 30m --text "Review the tests"
tcb schedule create --session example-project --at 2026-10-24T09:00+08:00 --text "Review the tests" --json
tcb schedule list --json
tcb schedule show <id> --json
tcb schedule cancel <id> --json
```

Supply exactly one of `--at` or `--in`. The ordinary local-control prohibition on
sending directly to the Home Operator also applies to scheduled CLI messages.
Structured output redacts home-directory paths. CLI-created results remain
inspectable with `show`; the creating CLI need not stay connected.

## Delivery And Recovery

The chosen time is the earliest input-submission time. A busy session queues the
message through the same user-input path as ordinary chat. Existing readiness,
project-conflict and applicable user-input checks remain in force. A submitted
instruction does not imply that the agent has completed its work.

Schedules survive a bot restart. Unsubmitted overdue messages are considered
after the service resumes, provided the exact original target still exists.
Deleting/recreating a session, reusing an independent slot, changing its workspace
or replacing the tmux server blocks delivery instead of redirecting it. A bot-only
restart can retain the same live target. Create a new schedule for a replacement
target. Scheduling does not create agents, install wake events, change sleep
policy or keep the host awake while waiting for a future time.

States distinguish waiting, queued, submitting, sent, blocked, failed, cancelled
and uncertain delivery. A successful tmux submission is recorded before waiting
for the response. Actual submission time and subsequent errors are inspectable.
Cancellation wins only before the durable submission claim; already submitted
input cannot be withdrawn by cancelling the schedule.

If a crash or tmux write failure leaves delivery uncertain, the bot never
automatically resends the instruction. Inspect the target before scheduling it
again. Notification failures also never trigger input replay. Repeated button
confirmation creates one schedule; two separately confirmed identical messages
remain two intentional instructions. Exactly-once agent execution cannot be
guaranteed across process failure and tmux submission.

Remote grants authorize creation/management at ingress. Grant expiry does not
revoke already admitted scheduled input, following the ordinary queued-input
security contract. This feature is separate from autonomous repair schedules,
recurring WorkOrders, and their capacity/admission policies.
