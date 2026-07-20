# tmux-claude-bot

Remote-control Claude Code or OpenAI Codex agents running inside tmux.

[![CI](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/ci.yml)
[![Release](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/release.yml/badge.svg)](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@octopusgarage/tmux-claude-bot?logo=npm)](https://www.npmjs.com/package/@octopusgarage/tmux-claude-bot)
[![Node](https://img.shields.io/badge/Node-22%2B-339933?logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Biome](https://img.shields.io/badge/Checked_with-Biome-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

`tmux-claude-bot` drives the real agent CLI through tmux, just like a person typing in the pane. It does not replace Claude Code or Codex with an API wrapper; it gives you a durable control layer around the interactive tools you already use.

<p align="center">
  <img src=".github/assets/demo-telegram-keyboard.png" alt="Telegram project controls" width="30%" />
  <img src=".github/assets/demo-voice.png" alt="Voice prompt transcription" width="30%" />
  <img src=".github/assets/demo-feishu.png" alt="Feishu Lark card output" width="30%" />
</p>

## Why

Long-running coding agents are useful, but the laptop terminal is a fragile place to babysit them. This project keeps each workspace in a named tmux session, serializes input through a queue, streams output back to chat, and lets you switch projects from Telegram, Feishu/Lark, a local CLI, or a TUI.

## Features

- **Multi-project sessions** - one tmux session per workspace.
- **Telegram and Feishu/Lark adapters** - use either chat app or both.
- **Local CLI and TUI** - control the same service from the machine.
- **Claude Code and Codex** - configure multiple agent launch commands.
- **Voice prompts** - optional local transcription flow for spoken requests.
- **Real-time output** - capture tmux pane output and stream it back.
- **Serialized execution** - one queue per session prevents interleaved commands.
- **Directory guard** - restrict projects to allowed workspace roots.
- **Managed service** - install with launchd on macOS or systemd on Linux.

## Quick Start

One-line install:

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash
```

Or install from npm:

```bash
npm i -g @octopusgarage/tmux-claude-bot
tmux-claude-bot setup
tmux-claude-bot run
```

Useful commands:

```bash
tmux-claude-bot doctor
tmux-claude-bot setup --reconfigure
tmux-claude-bot tui
tmux-claude-bot service status
```

## Architecture

```text
Telegram / Feishu / TUI / CLI
        |
        v
adapters/*  ->  core queue  ->  tmux send-keys
        ^                         |
        |                         v
renderers   <-  capture-pane  <-  Claude Code / Codex
```

Important boundaries:

| Layer | Responsibility |
|---|---|
| Adapters | Translate Telegram, Feishu/Lark, TUI, and CLI input into core commands. |
| Core | Route commands, serialize per-session work, enforce workspace rules, manage lifecycle. |
| tmux integration | Send keys, capture pane output, and detect idle/running state. |
| Renderers | Convert agent output into chat messages, cards, and terminal UI views. |

See [docs/manual.md](docs/manual.md) and [docs/adr](docs/adr/) for deeper design notes.

## Configuration

The setup wizard creates the service config and helps bind Telegram and/or Feishu/Lark. Typical prerequisites:

- Node.js 22+
- tmux
- Claude Code CLI or OpenAI Codex CLI installed and logged in
- Telegram bot token and/or Feishu/Lark app credentials
- macOS or Linux for managed service mode

## Safety Design

- Only configured users/groups can control sessions.
- Workspace roots are allowlisted.
- Commands flow through per-session queues.
- tmux output is captured after command dispatch, reducing stale-output confusion.
- Local service controls are exposed through a unix-domain socket, not a public network port.

## Development

```bash
npm install
npm run setup:lark
npm run doctor
npm run service:install
npm run service:uninstall
npm run dev
npm run build
npm test
npm run lint
npm run lint:types
```

Deeper checks:

```bash
npm run test:coverage
npm run knip
npm run mutation
npm run audit
```

## Docs

- [Manual](docs/manual.md)
- [Commands](docs/commands.md)
- [TUI](docs/tui.md)
- [Testing](docs/TESTING.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Related

- [telegram-bridge](https://github.com/OctopusGarage/telegram-bridge) - a smaller Telegram-only bridge for one tmux target.
- [octopusgarage-skills](https://github.com/OctopusGarage/octopusgarage-skills) - shared skills for Claude Code and Codex.
- [OctopusGarage](https://github.com/OctopusGarage) - small tools for AI agents, local automation, and browser-native products.

## Usage

### Configuration

All settings via `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | *(optional)* | Telegram bot token from @BotFather. Blank = Telegram off (Feishu-only) |
| `LARK_ENABLED` / `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_ALLOWED_OPEN_IDS` / `LARK_DOMAIN` | *(optional)* | Feishu/Lark adapter — set by `npm run setup:lark`. At least one of Telegram/Feishu must be configured. Feishu *project groups* need the `im:chat` and `im:message.group_msg` scopes (see [docs/commands.md](docs/commands.md)) |
| `CLAUDE_START_COMMAND` | `claude-yolo` | Command to launch Claude (a full line; may carry leading `VAR=value` env). Add `CLAUDE_START_COMMAND_2..N` (+ optional `CLAUDE_START_LABEL_n`) for a pick-on-start menu. Codex flavors use `CODEX_START_COMMAND[_N]` the same way (absent ⇒ codex disabled) — see `.env.example` |
| `IDLE_POLL_TICKS` | `3` | Consecutive idle polls before considered idle |
| `POLL_INTERVAL_MS` | `1000` | Milliseconds between idle polls |
| `MAX_OUTPUT_LINES` | `200` | Max tmux pane lines to capture |
| `MAX_MESSAGE_LENGTH` | `3500` | Max Telegram message size |
| `TELEGRAM_ALLOWED_USER_IDS` | *(empty)* | Comma-separated Telegram user IDs that can use the bot |
| `CD_ALLOWED_DIRS` | *(empty)* | Allowed directories for project creation |
| `LOG_LEVEL` | `INFO` | Minimum log level written to the JSONL log (`DEBUG`\|`INFO`\|`WARN`\|`ERROR`) |
| `TCB_LOG_DIR` | `~/.tmux-claude-bot/logs` | Directory for structured JSONL log files (overrides the default under `TCB_STATE_DIR`) |

### Session Naming

tmux session name format: `tmux_proj_<absolute-path>` with `/` replaced by `-`

Example: `/home/user/projects/myapp` → `tmux_proj_-home-user-projects-myapp`

The active session name is stored in `.current_project` (gitignored).

### Telegram Commands

#### Projects (no agent required)

| Command | Description |
|---------|-------------|
| `/list_projects` | List all `tmux_proj_*` sessions |
| `/current_project` | Show current project and session status |
| `/add_project <path>` | Create new project tmux session |
| `/switch_<N>` | Switch to project by number |
| `/remove_<N>` | Remove project session |

#### Agent control (session required)

| Command | When | Description |
|---------|------|-------------|
| `start` | session exists | Start the agent |
| `status` | session exists | Check if the agent is running |
| `peek` | session exists | Capture current tmux pane |
| `esc` | agent running | Send Escape key |
| `interrupt` | agent running | Send Ctrl-C |
| `exit` | agent running | Send /exit to the agent |
| `restart` | agent running | Restart, resuming the conversation |
| `clear` | agent running | Send /clear (clear context) |
| `compact` | agent running | Send /compact (compact context) |
| `enter` | agent running | Send Enter key |
| `up` / `down` | agent running | Send arrow keys |
| `help` | always | Show all commands |

Buttons and TUI shortcuts confirm before `exit`, `restart`, `clear`, or `compact`.
For CLI automation, use `tcb control <project> <action> --yes` for those actions.

#### Natural language

When the agent is running, any text message is sent to it and the result is returned.

### Voice transcription (optional)

Voice messages are transcribed locally with [mlx-whisper](https://pypi.org/project/mlx-whisper/)
(Apple Silicon only) and then forwarded to the agent like any text. **The feature is
off until you install it** — if you never use voice, you can ignore this entirely.

**Enable it (two ways):**

- **From Telegram:** send `/voice_install`. The bot runs the installer, enables the
  feature, and persists the path to `.env` — no restart needed. (No-op politely if
  the host isn't Apple Silicon.)
- **On the host:** `npm run whisper:install`, then put the printed path into
  `MLX_WHISPER_BIN` in `.env` (or re-run `npm run setup:reconfigure`).

**What gets installed** (project-managed, reproducible — nothing global):

- A project-local `.venv` created by [uv](https://docs.astral.sh/uv/), with
  `mlx-whisper` pinned in [`requirements.txt`](requirements.txt). Model weights
  (default `whisper-large-v3-turbo`, ~1.5GB — the only family that supports every
  offered language incl. Cantonese) download from HuggingFace on first
  transcription; override with `WHISPER_MODEL` in `.env`.
- **ffmpeg** is required to decode audio (`brew install ffmpeg`). The installer and
  `npm run doctor` both check for it.

If you send a voice message before enabling the feature, the bot replies with a
short note telling you how to turn it on — it never fails silently.

**Recognition language.** whisper's auto-detect often misreads Chinese as
Japanese, so transcription forces a language — **`zh` by default**. Switch any
time from Telegram with `/voice_lang <zh|en|yue|ja|es|auto>` (`auto` re-enables detection);
it persists to `.env`. Override the default with `WHISPER_LANGUAGE` in `.env`.

**Optional prompt translation.** If you prefer writing or speaking Chinese but
want the agent to receive English prompts, install the local Argos Translate package:

```bash
npm run translate:install
```

Or install from chat with `/translate_install` (Telegram/Feishu); Feishu also
shows an install button in the help card when Argos is not present.

Then set `PROMPT_TRANSLATE_MODE=argos`, `PROMPT_TRANSLATE_FROM=zh`, and
`PROMPT_TRANSLATE_TO=en` in `.env` (or set the `TELEGRAM_...` / `LARK_...` /
`CONTROL_...` overrides for one source). Runtime controls are
`/prompt_translate status|off|on [from] [to]` in Telegram/Feishu and
`tcb prompt-translate status|off|on [from] [to]` locally; the TUI `T` key toggles
control zh→en. The legacy `VOICE_TRANSLATE_MODE=argos_zh_en` alias still works.
When enabled, chat text, voice transcriptions, TUI input, and `tcb send` are
translated before they enter tmux. Leave `PROMPT_TRANSLATE_MODE=off` for the
default behavior.

### Agent Running Detection

The bot decides whether the agent is running by **process detection**, not screen
scraping: it walks the tmux pane's process tree (`pane_pid` → `ps`) and looks for the
agent process (`claude` or `codex`). Present → **running**; absent → **idle**. This is
theme- and output-independent. (Readiness — "the agent finished loading" — is still
detected from the pane, since the process exists before it is ready for input.)

### Structured Logs

The bot writes structured JSONL logs to `~/.tmux-claude-bot/logs/tcb-YYYYMMDD.jsonl` (one file per day, 30-day retention). Query them with the `tcb logs` CLI subcommand:

```bash
tcb logs                                # today's log (INFO+)
tcb logs --level WARN                   # WARN and ERROR only
tcb logs --session myapp                # filter by tmux session
tcb logs --trace t_a1b2c3d4             # all lines from one request trace
tcb logs --chat 123456                  # filter by chat id
tcb logs --channel telegram             # filter by protocol adapter
tcb logs --component core.queue         # filter by logger component
tcb logs --grep "timeout"               # substring match on msg
tcb logs --days 3 -n 50                 # last 50 lines from the past 3 days
tcb logs --json                         # output raw JSON lines
```

From within the chat, `/logs` (owner-only) shows recent WARN/ERROR entries for the current session. `/logs <traceId>` filters to one trace; `/logs N` shows the last N entries.

### Dashboard

Get a global status snapshot of all managed sessions with the `tcb dashboard` CLI subcommand:

```bash
tcb dashboard          # human-readable snapshot of all sessions
tcb dashboard --json   # raw JSON snapshot (DashboardSnapshot)
```

Each session row shows: agent kind, busy/idle state + current-task duration, uptime, cumulative busy time, and `/status` usage (context %, rate-limit state). The global header shows bot uptime, version, session count, active sessions, queue depth, and which adapters (Telegram/Lark) are enabled.

From within the chat, `/dashboard` (owner-only) shows the same information. On Lark it is restricted to p2p (direct) messages.

The snapshot is on-demand — there is no live auto-refresh.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Deployment & Resilience

### Production Deployment (macOS launchd)

The bot runs as a `launchd` service with automatic crash recovery:

```bash
npm run service:install     # install + start the launchd agent (auto-restart on crash/boot)
npm run service:uninstall   # stop and remove the launchd agent
npm run doctor              # verify it's healthy (single-instance check)
```

> [!WARNING]
> The installer uses `sed` to substitute `__PROJECT_DIR__` in the plist template before
> copying it to `~/Library/LaunchAgents/`. Do **not** copy the plist manually — the placeholder
> will be left unresolved and the service will fail to spawn.

**Features:**
- `KeepAlive` — auto-restart on crash
- `ThrottleInterval` — min 10s between restarts (prevents crash loops)
- Logs to `logs/launchd.out.log` and `logs/launchd.err.log`

### Resilience

| Mechanism | Behavior |
|-----------|----------|
| Network retry | `getMe` retries 5× with exponential backoff (1s→30s) |
| Message retry | Handler retries 3× with linear backoff (1s, 2s, 3s) |
| Queue persistence | Unprocessed messages saved to `.queue/pending.json` |
| Process auto-restart | launchd `KeepAlive` restarts bot on crash |
| Handler isolation | Single message failure does not block queue |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev, the
verification gates, and the install/deploy/release flow. In short:

- **Dev:** `npm install && npm run setup && npm run dev`
- **Deploy this machine:** `/deploy` (Claude command) or re-run the installer
- **Cut a release:** `/release [patch|minor|major]` — gates, bumps, tags, pushes
  (CI publishes the GitHub Release), then redeploys + verifies this machine

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Acknowledgments

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — the CLI this bot drives
- [grammY](https://grammy.dev) & [Feishu/Lark Node SDK](https://github.com/larksuite/node-sdk) — the chat adapters
- [mlx-whisper](https://pypi.org/project/mlx-whisper/) & [uv](https://docs.astral.sh/uv/) — local voice transcription
- [Argos Translate](https://github.com/argosopentech/argos-translate) — optional local prompt translation

<p align="right">(<a href="#readme-top">back to top</a>)</p>
