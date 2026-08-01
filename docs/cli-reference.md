# CLI Reference

This reference tracks the maintained `tcb ...` command surface. The user manual
explains workflows; this file exists so subcommands and options do not drift
silently from `src/cli.ts`.

## Top-Level Commands

- `tcb run`
- `tcb setup`
- `tcb setup:lark`
- `tcb doctor`
- `tcb install`
- `tcb service`
- `tcb dashboard`
- `tcb autopilot <project> [delegate [requirement]|cancel]`
- `tcb sysload`
- `tcb tui`
- `tcb sessions`
- `tcb projects`
- `tcb send`
- `tcb notify`
- `tcb prompt-translate`
- `tcb peek`
- `tcb open`
- `tcb open-worker`
- `tcb adopt`
- `tcb control`
- `tcb attach`
- `tcb skill`
- `tcb recover`
- `tcb logs`
- `tcb batch`
- `tcb task`
- `tcb loop`

## Nested Commands

- `tcb service install`
- `tcb service uninstall`
- `tcb service status`
- `tcb service pause`
- `tcb service resume`
- `tcb service restart`
- `tcb service logs`
- `tcb batch load <file>`
- `tcb batch export <id> [file]`
- `tcb batch start [id]`
- `tcb batch status`
- `tcb batch report`
- `tcb batch pause`
- `tcb batch resume`
- `tcb batch stop`
- `tcb task audit`
- `tcb task report`
- `tcb loop validate <file>`
- `tcb loop tick <file>`
- `tcb loop run <file> <projectId>`
- `tcb loop reports list`
- `tcb loop backlog list`
- `tcb loop backlog close <id>`
- `tcb loop skills list`
- `tcb loop skills sync <file>`
- `tcb loop skills refresh <file>`

## Options

- `--agent`
- `--all`
- `--attach`
- `--body`
- `--caption`
- `--channel`
- `--chat`
- `--component`
- `--days`
- `--dry-run`
- `--ended-at`
- `--error`
- `--force`
- `--grep`
- `--id`
- `--json`
- `--level`
- `--lines`
- `--name`
- `--n`
- `--no-wait`
- `--now`
- `--reconfigure`
- `--repair-status`
- `--report`
- `--scheduled-at`
- `--session`
- `--source`
- `--started-at`
- `--status`
- `--stdin`
- `--summary`
- `--timeout`
- `--title`
- `--to`
- `--tool`
- `--trace`
- `--write`
- `--yes`

## Notes

- `tcb autopilot <project>` means supervisor-backed delegation only.
- `tcb loop run` is for deterministic command-backed/manual runs; managed
  agent-supervised WorkOrders are driven by the scheduler and Loop Supervisor.
- `tcb notify` is a send-only owner/project notification path through the running
  bot.
- `tcb attach` sends files back to the chat-bound project session.
