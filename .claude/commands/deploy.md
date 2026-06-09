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
2. **Deploy** via the canonical installer (it preserves `.env` + runtime state,
   refreshes deps, and restarts the launchd service). Pass the target as the
   version; omit it for `latest`:
   ```
   TMUX_CLAUDE_BOT_VERSION="<latest|vX.Y.Z|main>" \
     bash -c "$(curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh)"
   ```
   For a local working-tree deploy instead, run `./install.sh` from the repo clone.
   Note: `raw.githubusercontent.com` caches `install.sh` ~5 min — if you just pushed
   an installer change, run `./install.sh` from the clone (or see `/release` Phase 4's
   checksum-poll) so you don't deploy with a stale installer.
3. **Verify** (all must hold):
   - Single instance, launchd-managed: `pgrep -fl "tmux-claude-bot.*src/index.ts"`
     shows one PID with PPID `1`; `launchctl list | grep com.octopusgarage.tmux-claude-bot`
     shows exit code `0`.
   - Healthy log: `tail -n 20 ~/.tmux-claude-bot/logs/launchd.out.log` shows
     `Connected to Telegram` and no `409` / `Conflict` / `error`.

## Report

State the target deployed, the old vs new PID, and the verification result. If a
second instance appears (409 risk), stop it so only the launchd-managed one
survives, then re-verify.
