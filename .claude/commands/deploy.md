---
description: Redeploy this machine's tmux-claude-bot to a release (or main) and verify it came up healthy
argument-hint: "[latest|vX.Y.Z|main]"
allowed-tools: Bash, Read
---

Redeploy the locally-running bot at `~/.tmux-claude-bot` without cutting a new
release. Use this to pull a published release onto this machine, or to roll
to/from `main`. For the full bump-tag-push-release flow use `/release` instead.

Arguments: `$ARGUMENTS` — the target: `latest` (default, newest published
release), an explicit `vX.Y.Z`, or `main` (track the branch via git).

Constants: repo `OctopusGarage/tmux-claude-bot` · launchd label
`com.octopusgarage.tmux-claude-bot` · install dir `~/.tmux-claude-bot` · log
`~/.tmux-claude-bot/logs/launchd.out.log`.

## Steps

1. **Preflight.** macOS only. Note the current PID:
   `launchctl list | grep com.octopusgarage.tmux-claude-bot`.
2. **Deploy** via the canonical installer (preserves `.env` + runtime state,
   refreshes deps, restarts the service). Run it so it targets the **install dir**,
   never the clone — download to `/tmp` and run it from there (its path can't be
   mistaken for a checkout):
   ```
   curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh -o /tmp/tcb-install.sh
   TMUX_CLAUDE_BOT_VERSION="<vX.Y.Z|main>" bash /tmp/tcb-install.sh   # omit the var for latest
   ```
   **Footgun (learned the hard way):** do NOT run `./install.sh` from inside the
   repo clone expecting a deploy — the installer would treat the clone as a local
   install, rebuild it in place, and `npm install --omit=dev` would strip its
   devDeps (breaking `tsc`/tests there). install.sh now guards this (piped stdin
   and a set `TMUX_CLAUDE_BOT_VERSION` both force install-dir mode), and the `/tmp`
   form above is immune regardless of cwd. The ONLY intended in-place build is a
   bare `./install.sh` from a clone with no version (a dev install).
   Stale-CDN note: `raw.githubusercontent.com` caches `install.sh` ~5 min; if you
   just pushed an installer change, see `/release` Phase 4's checksum-poll first.
3. **Verify** (all must hold):
   - Single instance, launchd-managed: `pgrep -fl "tmux-claude-bot.*(src/index.ts|dist/cli.js)"`
     shows one PID with PPID `1`; `launchctl list | grep com.octopusgarage.tmux-claude-bot`
     shows exit code `0`.
   - Healthy log: `tail -n 20 ~/.tmux-claude-bot/logs/launchd.out.log` shows
     `Connected to Telegram` and no `409` / `Conflict` / `error`.

## Report

State the target deployed, the old vs new PID, and the verification result. If a
second instance appears (409 risk), stop it so only the launchd-managed one
survives, then re-verify.
