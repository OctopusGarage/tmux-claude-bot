# ADR-0001: Bot Architecture Refactor

**Date:** 2026-05-04
**Status:** Accepted — extended by ADR-0002 (the `src/bot` / `src/services`
paths below were relocated to `src/adapters/telegram` / `src/core`; the layering
intent is unchanged).

## Context

The bot started as a single-file handler. As it grew, `handlers.ts` accumulated:
- Telegram command routing
- session resolution and reply-target map management
- project lifecycle logic (`/add_project`, `/remove_N`, etc.)
- queue orchestration
- baton orchestration

This made it hard to test, hard to find where logic lived, and easy to introduce bugs when adding features.

## Decision

Three-layer architecture:

```
┌─────────────────────────────────────┐
│         Router Layer                │  session resolution + reply routing
├─────────────────────────────────────┤
│    Command Executor Layer           │  action dispatch, queue vs immediate
├─────────────────────────────────────┤
│         Service Layer               │  tmux, claude, queue, output
│              +                     │
│       Project Manager               │  project lifecycle, current_project
└─────────────────────────────────────┘
```

### Layer 1 — Router

Stateless. Reads incoming Telegram message, resolves target session, attaches routing metadata.

Files: `src/bot/router.ts`

Responsibilities:
- Resolve session from reply-target or `current_project`
- Record reply-target mappings
- Handle `/switch_N`, `/remove_N`, `/add_project_N` — these mutate routing context only

### Layer 2 — Command Executor

Thin dispatcher. Classifies incoming action as queued-session / immediate / global-bot, then dispatches.

File: `src/bot/executor.ts`

Responsibilities:
- Classify action type (`IMMEDIATE_ACTIONS` vs queued session actions vs global)
- Call queue for queued actions
- Execute immediate actions directly
- Execute global actions directly

### Layer 3 — Service Layer

Pure capabilities, no bot-specific logic.

| Service | File | Responsibility |
|---------|------|----------------|
| Tmux | `src/services/tmux.ts` | tmux process management |
| Claude | `src/services/claude.ts` | Claude start/stop/idle detection |
| Queue | `src/services/queue.ts` | FIFO queue per session + global |
| Output | `src/services/output.ts` | tmux pane → Telegram message chunking |
| **Project Manager** | `src/services/project-manager.ts` | project lifecycle, session ↔ path mapping, current_project |
| History | `src/services/history.ts` | read Claude's own history files |

### Absorbed into Project Manager

- `sessionPathMap.ts` — only used by project manager
- `recentProjects.ts` — only used by project manager

### Absorbed into Router

- `reply-target.ts` — only created by router

### Unchanged

`tmux.ts`, `claude.ts`, `queue.ts`, `output.ts` — these are already clean.

## Consequences

- `handlers.ts` deleted — logic distributed across router + executor
- `sessionPathMap.ts` deleted — functionality moved to `project-manager.ts`
- `recentProjects.ts` deleted — functionality moved to `project-manager.ts`
- `reply-target.ts` deleted — functionality moved to `router.ts`
- `currentProject.ts` deleted — functionality moved to `project-manager.ts`
- `commands.ts` kept — only exports `BOT_COMMANDS`
- Easier to test: router and executor can be tested with mock services
