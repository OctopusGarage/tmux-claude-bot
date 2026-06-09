# Install guide (for an AI assistant or a human)

**tmux-claude-bot** is a macOS Telegram bot that drives Claude Code in tmux sessions.
You're reading this from an extracted release tarball. Follow these steps; give the
user the exact commands (or run them), ask for what's needed, and read any errors.

## 1. Prerequisites (macOS only — the bot runs as a launchd service)

- **node** v20+ — `node -v`. If missing, install via [nvm](https://github.com/nvm-sh/nvm).
- **tmux** — `tmux -V`. If missing: `brew install tmux`.
- **Claude Code CLI** (`claude`) — optional; the bot can use a custom `CLAUDE_START_COMMAND`. See https://docs.anthropic.com/en/docs/claude-code.

## 2. Get a Telegram bot token

In Telegram, message **@BotFather**, send `/newbot`, follow the prompts, and copy the
token it returns (looks like `123456:ABC-...`). The setup wizard will ask for it. (It
also auto-captures the user's numeric Telegram id — they just message the bot when
prompted — so the bot only obeys them.)

## 3. Install

Run the one-line installer (this is the canonical install; it places a managed copy in
`~/.tmux-claude-bot`, runs the setup wizard, and registers an auto-restarting service):

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash
```

The wizard asks for the bot token (validated live) and which directories the bot may
use. Re-running the one-liner later **updates** to the latest release; `.env` and state
are preserved. Pin a version with `TMUX_CLAUDE_BOT_VERSION=vX.Y.Z`.

## 4. Verify

- `launchctl list | grep com.octopusgarage.tmux-claude-bot` — shows a PID and exit code `0`.
- `tail -n 20 ~/.tmux-claude-bot/logs/launchd.out.log` — shows `Connected to Telegram`.
- Message the bot in Telegram — it should reply.

## 5. Manage / troubleshoot

- Logs: `~/.tmux-claude-bot/logs/launchd.out.log` and `launchd.err.log` (read these first on any failure).
- Health check: `cd ~/.tmux-claude-bot && npm run doctor`.
- Reconfigure: `cd ~/.tmux-claude-bot && npm run setup:reconfigure`.
- Restart: `launchctl kickstart -k gui/$(id -u)/com.octopusgarage.tmux-claude-bot`.
- Uninstall: `cd ~/.tmux-claude-bot && npm run service:uninstall`.
- Only one instance may run (Telegram returns 409 Conflict otherwise).
