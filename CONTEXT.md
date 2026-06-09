# Bot Domain

## Core job

Remote control Claude Code from a chat app — send commands, get results back.
Telegram is the current adapter; Feishu is planned. The platform-independent
logic lives in `src/core/`; each chat app is an adapter under `src/adapters/`.
See ADR-0002 for the layering.

## Layers (adapter → core → shared)

| Layer | Path | Responsibility |
|-------|------|----------------|
| **Adapter** | `src/adapters/telegram/` | Ingest platform messages, render results, keyboards/reactions/typing, network transport. One package per chat app. |
| **Core** | `src/core/` | Protocol-agnostic: tmux management, Claude lifecycle, command dispatch (`dispatch.ts`), queue, project management, history. Reusable by any adapter. |
| **Shared** | `src/shared/` | Leaf primitives: config, types, utils. No internal dependencies. |

`core/` must never import from `adapters/` — enforced by `.dependency-cruiser.cjs`.

## Entities

| Entity | Description |
|--------|-------------|
| **Project** | A directory + tmux session. Bot manages lifecycle. |
| **Session** | The tmux process. One per project. Hosts Claude. |
| **Chat** | A conversation in the messaging app (Telegram chat today). One bot serves many chats. |
| **Message** | User input. Classified as *action* (command) or *text* (natural language). |
| **Queue** | Serialized command backlog. |

## Routing

1. Message with explicit session target (reply to bot message) → that session
2. `/switch_N`, `/remove_N`, `/add_project_N` → change routing context only
3. All other messages → current project's session queue

## Command classification

| Class | Examples | Routing |
|-------|----------|---------|
| Immediate | `/esc`, `/interrupt`, `/status`, `/up`, `/down`, `/enter`, `/clear` | Sent directly, bypass queue |
| Queued session | natural language, `/start`, `/restart`, `/exit`, `/new` | Per-session queue |
| Bot-level | `/list_alive_projects`, `/queue_status`, `/history` | Direct execution |

## What bot does NOT own

- **Conversation state** — lives in Claude Code's own `~/.claude/projects/` files. Bot reads it opportunistically via `history.ts`.
- **tmux internals** — tmux pane is just a capture target.

## Key invariants

- One tmux session per project
- One active project per chat at a time (`.current_project`)
- Queued messages execute in FIFO order within a session
- `/esc` and `/interrupt` bypass queue — latency-critical interrupt signals
