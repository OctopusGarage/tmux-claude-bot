# Terminal UI (`tcb tui`)

A keyboard-driven control panel for the bot's tmux sessions, for use **at the PC**
— the local-terminal sibling of the Telegram and Feishu/Lark clients. Same idea as
`tmux`/`docker`: the bot is the always-on daemon, the TUI is just another client of
it. So a prompt you send from the TUI goes through the **same per-session queue** as
the chat adapters and can never race them.

It is **not** a terminal emulator. To see and type in a session's full live pane you
still `tmux attach`; the TUI is the bird's-eye orchestration layer on top — see every
session's status at a glance and drive them (send prompts, peek, control, restart).

## Launch

The bot must be running (the TUI connects to its control socket at
`<state-dir>/control.sock`).

```bash
# Managed service (normal install) — uses the same state dir as the service:
tcb tui

# Dev: start the bot, then run the TUI — `npm run tui` resolves the same dev
# profile/state dir as `npm run dev`, so it finds the running bot's socket:
npm run dev    # in one terminal (leave it running)
npm run tui    # in another
```

If the bot isn't up (or you piped it instead of running it in a real terminal) it
exits with a one-line hint instead of a blank screen. If the bot restarts while the
TUI is open, the TUI auto-reconnects.

## Layout

```
 tmux-claude-bot   1/6 busy · queue 0 · v0.2.0
╭ Sessions ───────────╮ ╭ geo-backend  busy ─────────────╮
│● 🟠 tmux-claude-bot ││ <live peek of the selected pane> │
│○ 🟠 geo-backend     ││                                  │
│○ ⚫ mesh-talk       ││                                  │
╰─────────────────────╯ ╰──────────────────────────────────╯
 j/k move · i prompt · p peek · e esc · x enter · r restart · q quit
```

- **Left** — every live session: `●` busy / `○` idle, the agent glyph (claude/codex),
  the project label, and the current-task duration while busy.
- **Right** — a live snapshot (peek) of the selected session's pane plus its status.
  The list and peek refresh automatically when the bot reports activity.

## Keys

| Key | Action |
|-----|--------|
| `j` / `k` (or ↓ / ↑) | move the selection (auto-peeks the selected session) |
| `p` | refresh the peek |
| `i` | compose a prompt for the selected session. **`Enter` sends**; **`Alt+Enter` inserts a newline** and **pasting multi-line text keeps its newlines** (bracketed paste) — so multi-line prompts work. `←`/`→` `↑`/`↓` move, `Ctrl-A`/`Ctrl-E` jump to line start/end, backspace edits at the cursor, `Esc` cancels. |
| `e` | send `Esc` to the session |
| `x` | send `Enter` to the session |
| `r` | restart the session's agent (resumes the conversation) |
| `l` | **logs** — recent WARN/ERROR for the selected session (any key to close) |
| `m` | **system load** — machine load / thermal / top CPU / runaway shells (any key to close) |
| `u` | **inputs** — recent inputs you sent to the selected session; `Enter` **re-runs** the selected one, `Esc` to close |
| `c` | controls overlay — the full action set (interrupt / clear / compact / esc / enter / restart / ↑ / ↓ / tab); press the number, `Esc` to close |
| `s` | **projects** overlay — every project (live `●` + stopped `◌`, recents included); `Enter` **opens + starts** the selected one (switch to a project / start a stopped one), `Esc` to close |
| `R` | **recover** — reboot recovery: relaunch the agents that were running before a restart (status shows launched / shell-only / already-alive counts) |
| `a` | **attach** — drop into the session's real, fully-interactive tmux pane; the TUI resumes when you detach (`Ctrl-b d`). Inside tmux it `switch-client`s instead |
| `q` | quit the TUI (the bot keeps running) |

A sent prompt is acked immediately; its reply lands in the status line when the agent
finishes (the run continues even if you quit the TUI — it's queued in the bot).

## How it works

- **Server:** the bot exposes a unix-domain control socket (`startControlServer`),
  alongside the Telegram/Lark adapters. Reads (`snapshot`, `peek`) reuse
  `buildDashboard` / `capturePaneColored`; writes (`send`, `control`) are enqueued
  through the bot's single queue as `ephemeral` messages (never persisted/restored —
  the TUI client is transient). The server pushes `activity`/`reply` events.
- **Client:** `tcb tui` (Ink/React) connects to the socket, renders the panel, and
  stays live off those events. Ink/React are loaded only by this subcommand, never by
  the daemon.

See the protocol in `src/adapters/control/protocol.ts`.
