# Bot Domain

## Core job

Remote control a **coding agent** from a chat app — send commands, get results
back. The agent is one of two interchangeable **kinds**, Claude Code or OpenAI
Codex; the bot is agent-agnostic and neither kind is privileged. Telegram and
Feishu/Lark are both implemented adapters (run either or both). The
platform-independent logic lives in `src/core/`; each chat app is an adapter
under `src/adapters/`. See ADR-0002 for the layering.

## Layers (adapter → core → shared)

| Layer | Path | Responsibility |
|-------|------|----------------|
| **Adapter** | `src/adapters/telegram/`, `src/adapters/lark/` | Ingest platform messages, render results, keyboards/reactions/typing, network transport. One package per chat app. |
| **Core** | `src/core/` | Protocol-agnostic: tmux management, agent lifecycle, command dispatch (`dispatch.ts`), queue, project management, history. Reusable by any adapter. |
| **Shared** | `src/shared/` | Leaf primitives: config, types, utils. No internal dependencies. |

`core/` must never import from `adapters/` — enforced by `.dependency-cruiser.cjs`.

## Entities

| Entity | Description |
|--------|-------------|
| **Project** | A directory the bot manages; its session name is **derived from the path**, so there is one session per directory (the default 1:1 case). |
| **Free Project** | A **path-independent session slot** (`tmux_proj_free_N`, max `FREE_PROJECT_LIMIT`). Its directory is assigned separately and is not unique — several free slots may target the same directory to run **parallel agents in one cwd**. The deliberate exception to one-session-per-directory. |
| **Session** | The tmux process. One per project/free slot. Hosts an Agent. |
| **Agent** | The coding agent running in a session — the thing the bot drives. |
| **Agent kind** | Which agent a session runs: `claude` or `codex`. Resolved from the LIVE process first (see invariants); falls back to the last launch-intent when stopped, else `claude`. |
| **Flavor** | A configured launcher variant of one kind — same binary, different env (e.g. `claude-stella`, `codex-yolo`). Discovered from shell rc aliases. |
| **Chat** | A conversation in a messaging app (a Telegram chat or a Lark group/DM). One bot serves many chats across both adapters. |
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

- **Conversation state** — lives in the agent's own files (Claude: `~/.claude/projects/<dir>/<uuid>.jsonl`; Codex: `~/.codex/sessions/**/rollout-*.jsonl`). Bot reads it opportunistically, parsing each into the same neutral transcript shape.
- **tmux internals** — tmux pane is just a capture target.

## Key invariants

- One tmux session per **path-derived** project. Free Projects intentionally allow
  N parallel sessions in a single directory — which is why a session's transcript
  is pinned to the agent pid's **open** file, not the newest file in the directory.
- One agent per session at a time; its **kind follows the live process** — the
  running agent wins over any recorded launch-intent (a manual desktop switch is
  followed, not overridden). Persisted intent is only the fallback when nothing
  is running. See ADR-0005.
- One active project per chat at a time (`.current_project`)
- Queued messages execute in FIFO order within a session
- `/esc` and `/interrupt` bypass queue — latency-critical interrupt signals
- **Live process / on-disk transcript is the source of truth; recorded state is
  fallback only.** State that matters across a bot restart is persisted under the
  state dir and restored on boot; desktop-side changes self-heal the record on the
  next interaction. New features must follow the Resilience Protocol in `CLAUDE.md`.
