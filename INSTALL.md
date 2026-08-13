# Install Guide

**tmux-claude-bot** is a macOS/Linux Telegram and Feishu/Lark bot that drives
Claude Code or OpenAI Codex in tmux sessions. This guide is suitable for a human
operator or an AI assistant installing from an extracted release tarball.

## 1. Prerequisites

- **Node.js** v22+ — `node -v`. If missing, install via
  [nvm](https://github.com/nvm-sh/nvm).
- **tmux** — `tmux -V`. If missing, install it with `brew install tmux` on macOS
  or `sudo apt install tmux` on Debian/Ubuntu.
- **Claude Code** (`claude`) or **Codex** (`codex`) — optional at install time;
  configure `CLAUDE_START_COMMAND` if you use a custom agent command.

## 2. Get Chat Credentials

For Telegram, message **@BotFather**, send `/newbot`, follow the prompts, and
copy the token it returns. The setup wizard also captures your numeric Telegram
user id after you message the bot once.

For Feishu/Lark, the setup wizard can launch the QR onboarding flow. You can also
run `tcb setup:lark` later.

## 3. Install Or Update

Run the one-line installer:

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash
```

The installer places the managed copy in `~/.tmux-claude-bot`, installs
dependencies, builds the runtime bundle, creates global launchers in
`~/.local/bin`, runs setup, registers the managed service, provisions the
isolated Home Operator workspace, installs the default Home Operator skill
there, removes stale global skill copies, and refreshes MCP profile descriptors
there.

The service-mode installer also refreshes the global launchers: managed dev
uses the source CLI from the active checkout, while managed prod uses the
installed bundle. Both continue to use the managed state directory.

Re-running the same command updates the managed copy while preserving `.env` and
runtime state. Pin a release with `TMUX_CLAUDE_BOT_VERSION=vX.Y.Z`.

Useful install-time opt-outs:

- `TCB_SKIP_SERVICE=1` — skip launchd/systemd registration.
- `TCB_SKIP_AI_TOOLS=1` — skip default AI tool surface installation.
- `TCB_SKIP_MCP=1` — legacy alias for skipping default AI tool surface installation.

## 4. Verify

Run the health check first:

```bash
tcb doctor
```

Then verify the managed service:

```bash
# macOS
launchctl list | grep com.octopusgarage.tmux-claude-bot

# Linux
systemctl --user status tmux-claude-bot
```

Finally, message the configured Telegram or Feishu/Lark bot. It should reply and
show the control panel.

## 5. Manage

- Health check: `tcb doctor`
- Reconfigure: `tcb setup --reconfigure`
- Add or refresh Feishu/Lark: `tcb setup:lark`
- Refresh default AI tool surfaces: `tcb ai-tools install`
- Inspect AI tool surfaces: `tcb ai-tools status`
- Refresh MCP descriptors only: `tcb mcp install`
- Skill scopes: `tcb skill status`; optional global copy:
  `tcb skill install --scope global`
- Terminal UI: `tcb tui`
- Restart service: `tcb service restart`
- Service logs: `tcb service logs`
- Uninstall: `tcb service uninstall`

Only one running bot instance should use the same state directory. If Telegram
reports a 409 conflict, stop the duplicate instance before restarting the
managed service.
