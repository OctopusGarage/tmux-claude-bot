---
description: Run a safe local dev session — borrow the deployed config, hot-reload, auto pause/resume the managed service
argument-hint: "[start|stop|status]"
allowed-tools: Bash, Read, Edit
---

Drive a local hot-reload dev session from the repo clone. `./dev.sh` borrows the
**deployed (prod) `.env`** so your code runs against the real token / proxy /
Feishu / Claude command with no second config to drift, and it **pauses the
managed launchd service while you develop and resumes it on exit** — the same
token on two long-pollers is a **409 Conflict**, so they must never run at once.
For deploying a release use `/deploy`; to cut one use `/release`.

Argument: `$ARGUMENTS` — `start` (default), `stop`, or `status`.

Constants: launchd label `com.octopusgarage.tmux-claude-bot` · deploy dir
`~/.tmux-claude-bot` (its `.env` is the single source of config) · clone code.

## status

- `npm run service:status` — managed service + bot process.
- `pgrep -fl "tmux-claude-bot.*(src/index.ts|dist/cli.js)"` — instance count (>1 ⇒ 409 risk). Managed runs `dist/cli.js`; a `./dev.sh` clone runs `src/index.ts`.
- Whether `./dev.sh` is currently running (paused prod + clone in hot-reload).

## start

1. Launch `./dev.sh` in the background. It will, in order: **pause** the managed
   service (if loaded), then run `tsx watch` with `TCB_ENV_FILE=~/.tmux-claude-bot/.env`
   (clone code + prod config, hot-reload).
2. Tail the dev output until `Connected to Telegram` (and `[lark] connected` if
   Feishu is configured); surface any error.
3. Tell the user: edits save -> reload instantly; **stop with `/dev stop`** (so
   prod is resumed cleanly).

You do NOT need a separate dev bot token anymore — dev borrows prod's, and prod
is paused for the duration.

## stop

1. `kill` the `dev.sh` process (SIGTERM, NOT `-9`) — its `trap` resumes the
   managed service automatically. If you only killed the watcher, or used `-9`,
   run `npm run service:resume` yourself.
2. Confirm with `npm run service:status` — exactly one healthy managed instance.

## Debugging recipes

- Health check: `cd ~/.tmux-claude-bot && npm run doctor` (or in the clone).
- Logs: `npm run service:logs` (managed), or watch the `./dev.sh` output.
- Inspect a project's pane: the bot's `/peek`, or `tmux attach -t <session>`.
- **NEVER `curl .../getUpdates` (or otherwise poll) the bot's token** to debug —
  it competes with the running bot's long-poll and stalls it (409). Read the
  bot's own logs / `doctor` instead.
- "Only `已接收`, no result" usually means the current project points at this bot's
  OWN repo session (a nesting loop) — switch to a real project, never the bot repo.
- Gates before a PR: `npm test`, `npm run lint`, `npm run lint:types`, `npm run knip`.

## Report

Say what you did (prod paused?), the dev PID + that it connected, and how to stop
(`/dev stop`, which resumes prod). If two instances are live, stop one and re-check.
