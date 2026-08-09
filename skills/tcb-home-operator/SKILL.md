---
name: tcb-home-operator
description: Use when the user wants to run, check on, or steer a background coding agent (Claude Code / Codex) in a managed session on this machine — send a prompt, check status, switch or start a project, peek at a pane, or stop work — or refers to "the bot" or a project session by name. Operated through the `tcb` CLI.
---

# Operating tmux-claude-bot

tmux-claude-bot runs coding agents (Claude Code / Codex) inside managed sessions on
this machine — one per project, several in parallel. You drive it through the **`tcb`
CLI**. The bot must be running; if a command says it can't reach the control socket,
inspect it with `tcb service status`; use `tcb service resume` when it is paused or
`tcb service restart` when it needs a clean restart. You are the **operator**, a
separate process — not one of the managed sessions.

## Start from docs, then use the CLI

For user-facing usage, read `docs/agents/usage-guide.md` first, then
`docs/manual.md`, `docs/commands.md`, or `docs/tui.md` for exact syntax. Do not
infer undocumented flags from source code.

For intelligent automation terminology, read `docs/intelligent-automation.md`.
Autopilot, Loop Engineering, Opportunity Discovery, PR review, Daily Task Audit,
and Runtime Guardian are WorkOrder/supervisor-backed flows, not ordinary chat
prompts.

## The core verbs

- **List** — `tcb sessions` (running ones) / `tcb projects` (all, incl. stopped).
  Add `--json` to parse the result.
- **Send a prompt** — `tcb send <project> "<prompt>"`. This is your main verb: it types
  the prompt into that project's agent and **waits for the reply, then prints it**.
  Use `--no-wait` to fire-and-forget, `--timeout <seconds>` to bound the wait
  (default 120s; raise it for long tasks).
- **Look** — `tcb peek <project>` prints a snapshot of its session pane.
- **Start / switch a project** — `tcb open <project>` (works for stopped projects too).
- **Control keys** — `tcb control <project> <esc|enter|interrupt|restart|clear|compact|up|down|tab>`.
- **Status / health** — `tcb dashboard` (all sessions), `tcb sysload` (machine load /
  heat / runaway processes / Resource Guardian), `tcb resource status` and
  `tcb resource incidents --limit 20` (Guardian detail), `tcb doctor` (install health).
- **Delegate clarified work** — `tcb autopilot <project> [requirement]`. Use this
  after the user has clarified a task and wants the supervisor to finish
  implementation, review, tests/evals when justified, PR policy, and final
  validation. Do not simulate Autopilot by sending a long prompt to the ordinary
  project chat.
- **Audit scheduled work** — `tcb task audit --force` checks the bot-hosted
  schedule ledger and can dispatch configured self-repair.
- **Loop Engineering admin** — `tcb loop validate|tick|reports|backlog|skills …`
  validates and inspects scheduled WorkOrders. Manual command-backed project runs
  are for local/system runners; agent-supervised code-changing work belongs to
  the managed Loop Supervisor.

**Reference a project by name** — a unique substring works (`geo` → `geo-backend`).
Never type the raw internal session id. If a name is ambiguous, the CLI lists the
matches; pick the right one or ask the user.

## Mapping requests → commands

- "Tell geo-backend to fix the failing test" → `tcb send geo-backend "fix the failing test"`, then relay the reply.
- "What's running / what's busy?" → `tcb sessions` (or `tcb dashboard` for detail).
- "Start / switch to <project>" → `tcb open <project>`.
- "Stop what it's doing / interrupt it" → `tcb control <project> esc`.
- "Show me what it's doing" → `tcb peek <project>`.
- "Is the machine ok / why is it slow?" → `tcb sysload`; use
  `tcb resource status` and `tcb resource incidents --limit 20` for Guardian evidence.
- Not sure which project they mean → `tcb projects`, then pick the unique match or ask.

## Good habits

- `send` can take a while — the agent is working; the command returns its reply when
  done. For a long task, bump `--timeout` or use `--no-wait` and check back with `tcb peek`.
- If the target project has active or recoverable Loop Supervisor work, do not
  inject unrelated ordinary chat into that project. Use status/peek/log controls,
  wait, cancel explicitly, or use the supervisor-backed delegation path.
- Don't send a prompt to the session that is THIS process. If unsure which sessions
  exist, `tcb sessions` first.
- When you can't resolve a request to one of these commands, say so and run `tcb doctor`;
  don't invent flags. `tcb --help` and `tcb <command> --help` are the authoritative,
  always-current reference — consult them rather than guessing.

## Modern automation shortcuts

- Clarified current task -> `tcb autopilot <project> "[requirement]"`.
- Proactive suggestions -> `/opportunity list|show|discuss|dismiss` in chat;
  execute approved work through Autopilot/supervisor delegation.
- Yesterday's schedules -> `tcb task audit --force`.
- Loop config health -> `tcb loop validate <config> --json`.
- Loop run history -> `tcb loop reports list --json` and
  `tcb loop backlog list --all --json`.

## Sending an image or file to the user

For an owner/background notification from another local project, prefer
`tcb notify --attach`:

    tcb notify --source radar --title "Radar ready" --body "Daily report attached" --attach report.md --attach report.html

It sends the text and uploads the files through the configured Telegram/Feishu
owner targets without requiring a chat-originated session.

Text replies from a chat-originated session reach the user automatically. To send an **image or file** (a
screenshot, a generated diagram, a report, a log), run:

    tcb attach <path> [--caption "<short description>"]

It uploads the file and sends it to the chat that asked. You can pass multiple
paths: `tcb attach a.png b.pdf`. This only works for chat-originated sessions; if
it prints "no chat is bound to this session", the work wasn't started from chat —
just describe the file's location in your text reply instead.
