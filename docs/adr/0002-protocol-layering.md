# ADR-0002: Protocol Layering (core / adapters / shared)

**Date:** 2026-06-09
**Status:** Accepted
**Extends:** ADR-0001 (which layered logic *within* the Telegram world)

## Context

ADR-0001 split the monolithic `handlers.ts` into router / executor / services.
That helped, but all three layers still lived inside the Telegram world: grammY's
`Context` was threaded through the executor, the prompt lifecycle, replies, and
views. There was no **seam** between *what a command means* and *how Telegram
delivers it*.

We now plan a second messaging front-end, Feishu/Lark. The tmux management,
Claude lifecycle, command semantics, queue, project management, and history
reading are all platform-independent and must be reused. Only the message
ingestion, rendering, keyboards/reactions/typing, and network transport are
Telegram-specific.

## Decision

Reorganize `src/` into three layers with a one-way dependency rule
**`adapters → core → shared`**:

```
src/
  core/                    protocol-agnostic, reusable by ANY platform
    dispatch.ts            command layer: Action → result string (was bot/executor)
    deps.ts                HandlerDeps — the core service bundle
    claude.ts, claude-config-resolver.ts        Claude lifecycle
    tmux.ts                                      tmux management
    queue.ts, output.ts, history.ts, transcriber.ts
    project-manager.ts, sessionPathMap.ts, recentProjects.ts, currentProject.ts
    onboarding.ts
  adapters/
    telegram/              the Telegram adapter (all former src/bot/)
      handlers, executor (grammY glue), replies, markdown, keyboards,
      reactions, typing, progress, prompt-lifecycle, voice-handler, views,
      callbacks, session, reply-routing, project-ops, reply-target, …
      transport/           smart-fetch, route-health (TG long-poll transport)
  shared/                  leaf primitives, depend on nothing internal
    config.ts, types.ts, utils/*
  index.ts                 composition root: builds core, wires the TG adapter
```

### The rule that matters

**`core/` must never import from `adapters/`.** This is enforced in CI by
`.dependency-cruiser.cjs` (rule `core-not-depend-on-adapters`) and `shared/` may
not import from `core`/`adapters` (`shared-are-primitives`). A second adapter
(`adapters/feishu/`) can be added later without touching `core/`.

### What changed mechanically (behavior-preserving)

- `bot/executor.ts` was **split**: the protocol-free `executeMessage` + action
  model moved to `core/dispatch.ts`; the grammY glue (`handleQueuedCommand`,
  `enqueueSessionCommand`, `createRestoredMessage`) stayed in
  `adapters/telegram/executor.ts`.
- `types.ts` was **split**: `HandlerDeps` (bundles core services) → `core/deps.ts`;
  pure config/value types (`AppConfig`, `BotCommand`, `ScriptConfig`) → `shared/types.ts`.
  This keeps the dependency direction one-way (shared has no inward edges).
- `reply-target.ts` and the `transport/` files moved into the Telegram adapter —
  their only consumer is Telegram (reply-target keys off TG `message_id`;
  transport races the TG long-poll). Easy to promote to `core` if Feishu needs them.
- Everything else was a file move; all imports rewritten; no logic edited.

## Deliberately deferred

The **outbound presentation port** (a `ChatPort`-style interface the core would
call to send/edit/react/show-actions, with each adapter implementing it) and the
**inbound `IncomingCommand`** abstraction are NOT introduced here. Today the core
still returns plain strings and Telegram renders them. Those abstractions will be
designed when Feishu integration actually starts — at that point we have two real
adapters to extract the seam against, rather than guessing from one. (See the
architecture principle: *one adapter = a hypothetical seam; two adapters = a real
seam.*)

## Consequences

- The reusable surface for a second platform is now exactly `src/core/` +
  `src/shared/`. Adding Feishu means adding `src/adapters/feishu/` and a second
  composition root branch in `index.ts`.
- CI fails if anyone re-couples core to a platform.
- `git mv` preserved history; the diff is dominated by import-path rewrites.
