---
name: tmux-claude-bot
description: Use when the user wants to run, check on, or steer a background coding agent (Claude Code / Codex) in a managed tmux session on this machine — send a prompt, check status, switch or start a project, peek at a pane, or stop work — or refers to "the bot" or a project session by name. Operated through the `tcb` CLI.
---

# Operating tmux-claude-bot

tmux-claude-bot runs coding agents (Claude Code / Codex) inside **tmux** sessions on
this machine — one per project, several in parallel. You drive it through the **`tcb`
CLI**. The bot must be running; if a command says it can't reach the control socket,
tell the user to start it (`tcb service start`). You are the **operator**, a separate
process — not one of the managed sessions.

## The verbs (this is the whole interface)

- **List** — `tcb sessions` (running ones) / `tcb projects` (all, incl. stopped).
  Add `--json` to parse the result.
- **Send a prompt** — `tcb send <project> "<prompt>"`. This is your main verb: it types
  the prompt into that project's agent and **waits for the reply, then prints it**.
  Use `--no-wait` to fire-and-forget, `--timeout <seconds>` to bound the wait
  (default 120s; raise it for long tasks).
- **Look** — `tcb peek <project>` prints a snapshot of its tmux pane.
- **Start / switch a project** — `tcb open <project>` (works for stopped projects too).
- **Control keys** — `tcb control <project> <esc|enter|interrupt|restart|clear|compact|up|down|tab>`.
- **Status / health** — `tcb dashboard` (all sessions), `tcb sysload` (machine load /
  heat / runaway processes), `tcb doctor` (install health).

**Reference a project by name** — a unique substring works (`geo` → `geo-backend`).
Never type the raw `tmux_proj_…` session id. If a name is ambiguous, the CLI lists the
matches; pick the right one or ask the user.

## Mapping requests → commands

- "Tell geo-backend to fix the failing test" → `tcb send geo-backend "fix the failing test"`, then relay the reply.
- "What's running / what's busy?" → `tcb sessions` (or `tcb dashboard` for detail).
- "Start / switch to <project>" → `tcb open <project>`.
- "Stop what it's doing / interrupt it" → `tcb control <project> esc`.
- "Show me what it's doing" → `tcb peek <project>`.
- "Is the machine ok / why is it slow?" → `tcb sysload`.
- Not sure which project they mean → `tcb projects`, then pick the unique match or ask.

## Good habits

- `send` can take a while — the agent is working; the command returns its reply when
  done. For a long task, bump `--timeout` or use `--no-wait` and check back with `tcb peek`.
- Don't send a prompt to the session that is THIS process. If unsure which sessions
  exist, `tcb sessions` first.
- When you can't resolve a request to one of these commands, say so and run `tcb doctor`;
  don't invent flags. `tcb --help` and `tcb <command> --help` are the authoritative,
  always-current reference — consult them rather than guessing.
