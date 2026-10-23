# Scheduled Messages Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for isolated implementation and spec/quality review. Steps use checkbox syntax for tracking.

**Goal:** Deliver durable one-time instructions to a pinned managed session through button-first Telegram/Feishu workflows and local CLI.

**Architecture:** One core scheduled-message service owns durable lifecycle and shared drafts. Adapters render native forms/keyboards; the existing message queue and dispatcher own actual input submission. Only a successful atomic submission claim permits a tmux write.

**Tech Stack:** TypeScript, Zod, existing atomic JSON infrastructure, Vitest, grammy, Feishu SDK, Unix control socket.

## Shared Interface Contract

Core exports live in `src/core/scheduled-messages/service.ts`, `drafts.ts`, `time.ts`, and `types.ts`:

```ts
type ScheduleOwner = { channel: "telegram" | "lark" | "control"; chatId: string; userId: string };
type ScheduledTarget = { sessionName: string; label: string; workspacePath: string | null; incarnation: string };
type ScheduledMessageRecord = {
  id: string; owner: ScheduleOwner; target: ScheduledTarget; text: string;
  dueAt: number; timezone: string; createdAt: number; updatedAt: number;
  status: "scheduled" | "queued" | "sending" | "sent" | "blocked" | "failed" | "cancelled" | "uncertain";
  sentAt?: number; error?: string; result?: string;
};
type ScheduleDeliveryEvent = { kind: "sent" | "result" | "error" | "blocked" | "uncertain"; text: string };
// getScheduledMessageService(deps) returns one service per HandlerDeps bundle.
// captureTarget(sessionName): Promise<ScheduledTarget>
// create({owner, sessionName, target?, text, when, requestId}): Promise<ScheduledMessageRecord>
// list(owner?): ScheduledMessageRecord[]; get(id, owner?): ScheduledMessageRecord | undefined
// cancel(id, owner?): ScheduledMessageRecord
// registerSender(channel, (record, event) => Promise<void>): () => void
// start(): () => void; tick(): Promise<void>; stop(): void
// parseScheduleTime(when: string, now?: number): {dueAt: number; timezone: string}
```

`owner` omitted is local operator authority only. Adapters always supply it.
Remote IDs are strings and callbacks never contain full message text or workspace paths.

```ts
type ScheduleDraft = {
  id: string; revision: number; owner: ScheduleOwner; target: ScheduledTarget;
  text: string; dueAt?: number; timezone?: string; expiresAt: number;
};
// getScheduleDrafts() returns shared draft storage.
// create(owner, target): ScheduleDraft; get(owner, id): ScheduleDraft | undefined
// update(owner, id, {target?, text?, when?}, expectedRevision?): ScheduleDraft
// bindPrompt(owner, id, messageId, kind: "text" | "time"): void
// findPrompt(owner, messageId): {draft: ScheduleDraft; kind: "text" | "time"} | undefined
// discard(owner, id): boolean
// confirm(owner, id, service, expectedRevision?): Promise<ScheduledMessageRecord>
```

The i18n helper is `scheduleMessages(channel)` from `src/core/i18n/scheduled-messages.ts`, backed by `catalog/scheduled-messages.ts`. Keys are coordinated before adapter integration.

## Task 1: Core Persistence, Time And Delivery

**Files:** New `src/core/scheduled-messages/{types,time,store,target,service,drafts}.ts`; modify `src/core/command/{queue-message,queue,dispatch}.ts`; tests in `tests/scheduled-messages/` and dispatcher regressions.

- [x] Write tests before implementation: creating a future record does not write to tmux, repeated ticks hand off once, submission claim competes with cancellation, restart requeues only unclaimed records, and interrupted submissions become uncertain.

```ts
expect(parseScheduleTime("30m", now).dueAt).toBe(now + 30 * 60_000);
await service.tick();
expect(queue.enqueue).not.toHaveBeenCalled();
// Advance injected clock to dueAt; call tick twice; assert one stable message ID.
```

- [x] Run `pnpm exec vitest run tests/scheduled-messages`; verify red for missing behavior.
- [x] Implement validated, strict durable storage and atomic transitions; target incarnation probes use argument arrays, exact tmux names and workspace snapshots. Scope ownership on every operation.
- [x] Add optional queue dedupe identity and dispatcher hooks immediately before/after the tmux write. Failed readiness does not falsely mark a message sent. Ordinary messages retain existing behavior.
- [x] Implement shared drafts, 30-minute expiry, revision checks, prompt bindings and idempotent confirmation.
- [x] Verify focused suites, serialization corruption cases, timezone/calendar cases and a real isolated tmux delivery.

## Task 2: Telegram Button Composer

**Files:** New `src/adapters/telegram/scheduled-messages.ts`; integrate `handlers.ts`, `callbacks.ts`, `keyboards.ts`, command registration; tests under `tests/adapters/telegram/`.

- [x] Write failing tests for Schedule entry buttons, reply-only content intake, shortcut/custom time selection, review/confirm, list/details/cancel and duplicate confirmation.
- [x] Implement thin handlers over the shared service/drafts. Preserve reply-target routing and bound-group restrictions. Session selection in the composer never changes current chat routing.
- [x] Add calendar, hour/minute controls and an exact-time reply alternative; all callback payloads are compact and owner scoped. Every draft screen supports back/discard.
- [x] Register a channel sender for eventual sent/result/error receipts, preserving normal session reply controls.
- [x] Run adapter suites and callback authorization/stale-revision tests; assert no ordinary message is consumed as draft input.

## Task 3: Feishu Native Form Composer

**Files:** New `src/adapters/lark/scheduled-messages.ts`; integrate `handlers.ts`, `card-actions.ts`, `cards.ts`, `commands.ts` and views; tests under `tests/adapters/lark/`.

- [x] Write failing tests for native form JSON, date/time/message fields, signed callbacks, form submission to review, explicit final confirmation, list/details/cancel and repeated submissions.
- [x] Implement the form and review cards over shared drafts/service. Keep text on validation failure; preserve chat policy, signature checks and bound-session restrictions.
- [x] Register delayed-result delivery without retaining ingress event closures. Keep card element counts bounded and fallback text recoverable.
- [x] Verify form value normalization, private/group routing, stale/cross-owner callbacks and interaction tests.

## Task 4: Runtime, CLI, Localization And Documentation

**Files:** `src/bootstrap.ts`, `src/index.ts`, `src/adapters/control/{protocol,operations,client}.ts`, `src/cli.ts` or new CLI registration module, i18n helper/catalog, `src/core/command/help-catalog.ts`, relevant docs.

- [x] Add failing control/CLI tests for create/list/show/cancel, invalid timestamps, missing target, authorization boundaries and unavailable service.
- [x] Wire service startup/shutdown once transports are ready; local control invokes the same service. Preserve host power ownership and existing remote admission semantics.
- [x] Implement `tcb schedule create --session ... (--at ... | --in ...) --text ...`, list/show/cancel and JSON output. Apply home path redaction to user-facing output.
- [x] Provide all six supported locales for buttons, errors, status, preview, dates and receipts; no user-facing strings in ordinary source files.
- [x] Update CLI/chat docs, usage recipes, manual, alignment and capability matrix. Document time as earliest submission, restart catch-up, invalid target blocking and uncertain delivery.

## Task 5: Integration And Review

- [x] Review each adapter against the approved spec, then review code quality and close findings.
- [x] Run focused queue/dispatcher, both channel, control/CLI, localization and documentation contract suites.
- [x] Run a real isolated tmux smoke: verify no early input, one exact multiline submission, cancellation and target isolation. Remove only the smoke-owned session.
- [ ] Run `pnpm verify:local`, normal commit hooks, merge the verified feature into `dev`, and push through the normal pre-push gate. Verify remote HEAD and clean source worktree.

## Scope Review

All approved requirements map to tasks above. This feature adds no recurring WorkOrders, direct provider clients, host wake events, arbitrary shell actions, new MCP tools or TUI editor. Draft editing is supported; confirmed schedules use cancel/recreate. No live user configuration is committed.
