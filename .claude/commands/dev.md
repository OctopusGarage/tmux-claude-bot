---
description: Run a safe local dev session — avoid the 409 clash with the managed service, launch tsx watch, and debug
argument-hint: "[start|stop|status]"
allowed-tools: Bash, Read, Edit
---

Drive a local development session from the repo clone (`npm run dev` = tsx watch, hot
reload). The one hazard: the production bot runs as a launchd service against the same
Telegram token — two long-pollers on one token = **409 Conflict**. This flow keeps them
from clashing. For deploying a release use `/deploy`; to cut one use `/release`.

Argument: `$ARGUMENTS` — `start` (default), `stop`, or `status`.

Constants: launchd label `com.octopusgarage.tmux-claude-bot` · deploy dir
`~/.tmux-claude-bot` · this clone's config `.env`.

## status

Report what's live so the user knows the lay of the land:
- `npm run service:status` — managed service + bot process.
- `pgrep -fl "tmux-claude-bot.*src/index.ts"` — count instances (more than one ⇒ 409 risk).
- Compare `BOT_TOKEN` in `./.env` vs `~/.tmux-claude-bot/.env` — same token means dev and
  prod can't both run.

## start

1. **Avoid the 409.** Decide based on tokens:
   - **Different tokens** (recommended): this clone's `.env` has a *separate dev bot*
     token (from @BotFather). Prod keeps running untouched — nothing to pause. If `.env`
     is missing, run `npm run setup`; to switch this clone to a dev token,
     `npm run setup:reconfigure`.
   - **Same token**: pause the service first — `npm run service:pause` (resume later with
     `npm run service:resume`). State that prod is now down for the dev session.
2. **Launch** hot-reload dev (proxy-free): `./dev.sh` (or `npm run dev`). Run it in the
   background, then tail until `Connected to Telegram` confirms it's up; surface any error.
3. Tell the user edits hot-reload automatically, and how to stop (below).

## stop

1. Stop the dev watcher: `kill $(pgrep -f "tmux-claude-bot.*src/index.ts")` (the clone's
   dev process). Confirm it's gone.
2. If you paused prod in `start`, bring it back: `npm run service:resume`, then
   `npm run service:status` to confirm one healthy managed instance.

## Debugging recipes

- Health check: `npm run doctor`.
- Dev/prod logs: `npm run service:logs` (managed), or watch the dev terminal.
- Inspect what Claude shows in a project's pane: the bot's `/peek` command, or
  `tmux attach -t <session>`.
- Gates before a PR: `npm test`, `npm run lint`, `npm run lint:types`, `npm run knip`.

## Report

Say what you did (token mode, whether prod was paused), the dev PID + that it connected,
and the exact command to stop/restore. If two instances are live, stop one and re-check.
