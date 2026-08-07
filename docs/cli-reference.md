# CLI Reference

This reference tracks the maintained `tcb ...` command surface. The user manual
explains workflows; this file exists so subcommands and options do not drift
silently from `src/cli.ts`.

## Top-Level Commands

- `tcb run`
- `tcb setup`
- `tcb setup:lark`
- `tcb doctor`
- `tcb config`
- `tcb automation`
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
- `tcb prompts`
- `tcb peek`
- `tcb open`
- `tcb open-worker`
- `tcb adopt`
- `tcb control`
- `tcb attach`
- `tcb skill`
- `tcb mcp`
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
- `tcb config list`
- `tcb config get <key>`
- `tcb config set <key> <value>`
- `tcb automation status`
- `tcb automation pause <loop|task-audit|runtime-guardian|batch>`
- `tcb automation resume <loop|task-audit|runtime-guardian|batch>`
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
- `tcb loop targets list <file>`
- `tcb loop targets enable <file> <project|workspace|repo> <id>`
- `tcb loop targets disable <file> <project|workspace|repo> <id>`
- `tcb loop backlog list`
- `tcb loop backlog close <id>`
- `tcb loop skills list`
- `tcb loop skills sync <file>`
- `tcb loop skills refresh <file>`
- `tcb capabilities list`
- `tcb capabilities status --task <taskKind>`
- `tcb capabilities install --default`
- `tcb capabilities update --default`
- `tcb prompts governed list`
- `tcb prompts governed show <promptId>`
- `tcb prompts governed render <promptId>`
- `tcb prompts governed check`
- `tcb prompts governed eval [promptId]`
- `tcb ai-tools install`
- `tcb ai-tools status`
- `tcb skill install`
- `tcb skill status`
- `tcb skill uninstall`
- `tcb mcp observer`
- `tcb mcp home`
- `tcb mcp install`

## Options

- `--agent`
- `--all`
- `--attach`
- `--body`
- `--caption`
- `--channel`
- `--chat`
- `--command`
- `--component`
- `--days`
- `--dir`
- `--dry-run`
- `--ended-at`
- `--error`
- `--force`
- `--fixture`
- `--grep`
- `--id`
- `--json`
- `--level`
- `--lines`
- `--name`
- `--n`
- `--no-wait`
- `--now`
- `--output`
- `--profile`
- `--reconfigure`
- `--repair-status`
- `--report`
- `--run-id`
- `--scheduled-at`
- `--session`
- `--since`
- `--source`
- `--scope`
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
- `tcb config list` and `tcb config get` redact secrets by default. Generic
  `config set` accepts only allowlisted non-secret keys; use `tcb setup
  --reconfigure`, `tcb setup:lark`, or a dedicated command for tokens, app
  secrets, and owner ids.
- `tcb automation ...` is the supported top-level control for high-cost
  background loops. `pause` records the previous tick/enabled values in state so
  `resume` can restore the prior cadence instead of guessing a default.
- `tcb loop run` is for deterministic command-backed/manual runs; managed
  agent-supervised WorkOrders are driven by the scheduler and Loop Supervisor.
- `tcb loop targets ...` is the supported way to inspect, pause, and resume
  Loop Engineering projects, workspaces, and repository-wide PR review entries
  without hand-editing YAML.
- `tcb notify` is a send-only owner/project notification path through the running
  bot.
- `tcb attach` sends files back to the chat-bound project session.
- `tcb prompts governed ...` is for repo-owned system prompts and prompt
  governance. It is separate from chat `/prompts`, which browses an external MCP
  prompt library.
