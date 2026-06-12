# tmux-claude-bot

[![CI](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/OctopusGarage/tmux-claude-bot/branch/main/graph/badge.svg)](https://codecov.io/gh/OctopusGarage/tmux-claude-bot)
[![version](https://img.shields.io/github/package-json/v/OctopusGarage/tmux-claude-bot)](https://github.com/OctopusGarage/tmux-claude-bot/releases/latest)
[![npm](https://img.shields.io/npm/v/@octopusgarage/tmux-claude-bot?logo=npm)](https://www.npmjs.com/package/@octopusgarage/tmux-claude-bot)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)](#requirements)
[![Checked with Biome](https://img.shields.io/badge/Checked_with-Biome-60a5fa?logo=biome)](https://biomejs.dev)

A chat bot that drives [Claude Code](https://docs.anthropic.com/en/docs/claude-code) inside tmux sessions — remote-control your local Claude from **Telegram and/or Feishu/Lark**, with voice and text input. Supports **multiple projects**, each with its own tmux session. Pick one chat app or run both.

## Contents

- [Features](#features)
- [Demo](#demo)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Session Naming](#session-naming)
- [Telegram Commands](#telegram-commands)
- [Voice transcription](#voice-transcription-optional)
- [Claude Running Detection](#claude-running-detection)
- [Production Deployment](#production-deployment-macos-launchd)
- [Resilience](#resilience)
- [Development & releases](#development--releases)
- [Requirements](#requirements)

## Features

- **Multi-project tmux sessions** — each project gets its own tmux session (`tmux_proj_<path>`)
- **Project switching** — create, switch, and remove projects via Telegram/Feishu commands & buttons
- **Feishu/Lark project groups** — bind a Feishu group to one workspace, so you switch projects by switching groups (no `/cd`); works without `@bot`. See [docs/commands.md](docs/commands.md)
- **Multiple start commands** — configure several Claude launch commands (different env/model/API key) and pick which to start from a button
- **Real-time output streaming** — captures tmux pane and streams output to the chat
- **Queue-based execution** — prevents concurrent commands from interleaving
- **Idle detection** — polls tmux pane to detect when Claude is idle vs. running
- **Directory guard** — operations restricted to configured allowed directories

## Demo

| Telegram — keyboard & output | Voice transcription | Feishu/Lark |
|:---:|:---:|:---:|
| ![Telegram keyboard](.github/assets/demo-telegram-keyboard.png) | ![Voice](.github/assets/demo-voice.png) | ![Feishu](.github/assets/demo-feishu.png) |

## Architecture

```
   ┌──────────────┐                        ┌──────────────┐
   │   Telegram   │                        │  Feishu/Lark │
   │  app (user)  │                        │  app (user)  │
   └──────┬───────┘                        └──────┬───────┘
          │                                       │
   HTTPS long-poll                         WebSocket (persistent)
   getUpdates / sendMessage                events + Open API reply
          │                                       │
   ┌──────▼───────────────────────────────────────▼──────┐
   │      tmux-claude-bot   (node dist/cli.js run)        │  launchd service
   │                                                      │  (single instance)
   │  ┌─────────────────┐         ┌─────────────────┐     │
   │  │ adapters/telegram│        │  adapters/lark  │     │  protocol glue:
   │  │     (grammY)     │        │ (@larksuite sdk)│     │  receive / render /
   │  └───────┬─────────┘         └────────┬────────┘     │  buttons & cards
   │          └─────────────┬──────────────┘              │
   │                 ┌──────▼───────┐                     │
   │                 │     core/    │  dispatch  — meaning │  protocol-agnostic
   │                 │   dispatch   │  queue     — serial  │  (no platform code;
   │                 │   queue      │  claude.ts — Claude  │   reused by any
   │                 │   claude.ts  │              lifecycle│   adapter)
   │                 │   tmux.ts    │  tmux.ts   — sessions │
   │                 └──────┬───────┘                     │
   └────────────────────────┼─────────────────────────────┘
                            │
             tmux send-keys │ ▲ capture-pane
              (inject cmd)  │ │ (scrape output)
                            ▼ │
                  ┌──────────────────────┐
                  │     tmux session      │  one per project
                  │  ┌────────────────┐   │
                  │  │  Claude Code    │   │  interactive CLI,
                  │  │     CLI         │   │  foreground in the pane
                  │  └────────────────┘   │
                  └──────────────────────┘
```

**Message round-trip:**

1. User sends a message in **Telegram / Feishu**.
2. The matching **adapter** receives it (long-poll / WebSocket) and normalizes it to a core command.
3. **`core/dispatch`** routes it; **`tmux.ts`** injects it into the project's tmux session via `send-keys`.
4. **Claude Code** processes it in the pane; the bot reads the result with `capture-pane`.
5. The adapter **renders the reply back** to the originating platform.

**Key points:**

- **Two inbound transports** — Telegram *polls* (HTTPS long-poll), Feishu *pushes* (persistent WebSocket); each reply goes back out its own platform.
- **One-way layering `adapters/ → core/ → shared/`** — `core/` knows nothing about any chat platform, so adding Feishu was just another adapter; the tmux + Claude machinery is fully reused.
- The bot **drives the Claude Code CLI like a user typing in tmux** (send-keys + screen-scrape), rather than calling an LLM API — which is why tmux sits in the middle.

## Quick Start

**Two first-class install methods — both stand up the same managed launchd service** (guided wizard + auto-restart at `~/.tmux-claude-bot`). Pick either:

- **`curl … | bash`** (below) — the one-liner installer; nothing to install first beyond `node`/`tmux`.
- **[npm](#install-via-npm)** — `npm i -g @octopusgarage/tmux-claude-bot && tmux-claude-bot install`, with build provenance.

### Install (macOS) — `curl | bash`

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash
```

The installer checks prerequisites (`node`, `tmux`, Claude Code CLI), installs
dependencies, then runs a guided wizard that:

1. asks which **chat app** to connect — **Telegram, Feishu/Lark, or both**,
2. **Telegram:** asks for your **bot token** ([@BotFather](https://t.me/BotFather)), validates it live, and auto-captures your Telegram id (just message the bot),
3. **Feishu/Lark:** renders a **QR code** — scan it to create the app; credentials are written for you,
4. asks which project directories the bot may use,

and finally installs and starts the bot as a launchd service (auto-restart on crash/boot).

> Re-running the installer **updates code + dependencies and restarts the service while preserving your `.env` and runtime state** — a safe one-click update. Add Feishu later anytime with `npm run setup:lark`.

> Prefer to clone first? `git clone … && cd tmux-claude-bot && ./install.sh` does the same thing in place.
> The install location defaults to `~/.tmux-claude-bot`; override it with `TMUX_CLAUDE_BOT_DIR=/path`.

### Install with an AI assistant

Not comfortable on the command line? Copy this prompt to any AI assistant (ChatGPT,
Claude, Gemini, or an agent with shell access) — it downloads the release, reads the
bundled guide, and walks you through it:

```text
Install "tmux-claude-bot" on my Mac for me (open-source, macOS-only). Download the latest
release tarball from https://github.com/OctopusGarage/tmux-claude-bot/releases/latest,
extract it, read the INSTALL.md inside, and follow it. Guide me step by step and ask me
for anything it needs (like my Telegram bot token).
```

By default the installer fetches the **latest stable release** — a lean tarball
without `tests/`, `docs/`, or dev-config files. Pin a specific version, or track `main`:

```bash
# pin a released version (see github.com/OctopusGarage/tmux-claude-bot/releases)
TMUX_CLAUDE_BOT_VERSION=v0.1.5 curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash

# track the latest main (development)
TMUX_CLAUDE_BOT_VERSION=main curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash
```

### Install via npm

Published as **[`@octopusgarage/tmux-claude-bot`](https://www.npmjs.com/package/@octopusgarage/tmux-claude-bot)** with build [provenance](https://docs.npmjs.com/generating-provenance-statements). A **full managed install** (equivalent to the `curl … | bash` above — provisions `~/.tmux-claude-bot`, runs the wizard, registers the launchd service):

```bash
npm i -g @octopusgarage/tmux-claude-bot
tmux-claude-bot install
```

`tmux-claude-bot install` materializes the prebuilt package into the stable `~/.tmux-claude-bot` and runs the service from there — so the launchd daemon never depends on the volatile global npm path (which moves with node versions / `npm update`). Update later with:

```bash
npm i -g @octopusgarage/tmux-claude-bot@latest && tmux-claude-bot install
```

Or run the CLI ad-hoc without a managed service (`run` / `setup` / `doctor` / `service …`):

```bash
npx @octopusgarage/tmux-claude-bot --help
```

### Manage

```bash
npm run service:install     # (re)install + start the launchd service
npm run doctor              # health check (incl. single-instance 409 guard)
npm run setup:reconfigure   # change token / authorized users / directories
npm run service:uninstall   # stop and remove the launchd service
```

### First message

In Telegram: `/add_project ~/projects/myapp` then `/start`.

## Configuration

All settings via `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | *(optional)* | Telegram bot token from @BotFather. Blank = Telegram off (Feishu-only) |
| `LARK_ENABLED` / `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_ALLOWED_OPEN_IDS` / `LARK_DOMAIN` | *(optional)* | Feishu/Lark adapter — set by `npm run setup:lark`. At least one of Telegram/Feishu must be configured. Feishu *project groups* need the `im:chat` and `im:message.group_msg` scopes (see [docs/commands.md](docs/commands.md)) |
| `CLAUDE_START_COMMAND` | `claude-yolo` | Command to launch Claude (a full line; may carry leading `VAR=value` env). Add `CLAUDE_START_COMMAND_2..N` (+ optional `CLAUDE_START_LABEL_n`) for a pick-on-start menu — see `.env.example` |
| `IDLE_POLL_TICKS` | `3` | Consecutive idle polls before considered idle |
| `POLL_INTERVAL_MS` | `1000` | Milliseconds between idle polls |
| `MAX_OUTPUT_LINES` | `200` | Max tmux pane lines to capture |
| `MAX_MESSAGE_LENGTH` | `3500` | Max Telegram message size |
| `TELEGRAM_ALLOWED_USER_IDS` | *(empty)* | Comma-separated Telegram user IDs that can use the bot |
| `CD_ALLOWED_DIRS` | *(empty)* | Allowed directories for project creation |

## Session Naming

tmux session name format: `tmux_proj_<absolute-path>` with `/` replaced by `-`

Example: `/home/user/projects/myapp` → `tmux_proj_-home-user-projects-myapp`

The active session name is stored in `.current_project` (gitignored).

## Telegram Commands

### Projects (no Claude required)

| Command | Description |
|---------|-------------|
| `/list_projects` | List all `tmux_proj_*` sessions |
| `/current_project` | Show current project and session status |
| `/add_project <path>` | Create new project tmux session |
| `/switch_<N>` | Switch to project by number |
| `/remove_<N>` | Remove project session |

### Claude control (session required)

| Command | When | Description |
|---------|------|-------------|
| `start` | session exists | Start Claude session |
| `status` | session exists | Check if Claude is running |
| `peek` | session exists | Capture current tmux pane |
| `esc` | Claude running | Send Escape key |
| `interrupt` | Claude running | Send Ctrl-C |
| `exit` | Claude running | Send /exit to Claude |
| `restart` | Claude running | Restart with --continue flag |
| `clear` | Claude running | Send /clear (clear context) |
| `compact` | Claude running | Send /compact (compact context) |
| `enter` | Claude running | Send Enter key |
| `up` / `down` | Claude running | Send arrow keys |
| `help` | always | Show all commands |

### Natural language

When Claude is running, any text message is sent to Claude and the result is returned.

## Voice transcription (optional)

Voice messages are transcribed locally with [mlx-whisper](https://pypi.org/project/mlx-whisper/)
(Apple Silicon only) and then forwarded to Claude like any text. **The feature is
off until you install it** — if you never use voice, you can ignore this entirely.

**Enable it (two ways):**

- **From Telegram:** send `/voice_install`. The bot runs the installer, enables the
  feature, and persists the path to `.env` — no restart needed. (No-op politely if
  the host isn't Apple Silicon.)
- **On the host:** `npm run whisper:install`, then put the printed path into
  `MLX_WHISPER_BIN` in `.env` (or re-run `npm run setup:reconfigure`).

**What gets installed** (project-managed, reproducible — nothing global):

- A project-local `.venv` created by [uv](https://docs.astral.sh/uv/), with
  `mlx-whisper` pinned in [`requirements.txt`](requirements.txt). Model weights are
  downloaded from HuggingFace on first transcription.
- **ffmpeg** is required to decode audio (`brew install ffmpeg`). The installer and
  `npm run doctor` both check for it.

If you send a voice message before enabling the feature, the bot replies with a
short note telling you how to turn it on — it never fails silently.

**Recognition language.** whisper's auto-detect often misreads Chinese as
Japanese, so transcription forces a language — **`zh` by default**. Switch any
time from Telegram with `/voice_lang <zh|en|auto>` (`auto` re-enables detection);
it persists to `.env`. Override the default with `WHISPER_LANGUAGE` in `.env`.

## Claude Running Detection

The bot decides whether Claude is running by **process detection**, not screen
scraping: it walks the tmux pane's process tree (`pane_pid` → `ps`) and looks for a
`claude` process. Present → **running**; absent → **idle**. This is theme- and
output-independent. (Readiness — "Claude finished loading" — is still detected from
the pane, since the process exists before it is ready for input.)

## Production Deployment (macOS launchd)

The bot runs as a `launchd` service with automatic crash recovery:

```bash
npm run service:install     # install + start the launchd agent (auto-restart on crash/boot)
npm run service:uninstall   # stop and remove the launchd agent
npm run doctor              # verify it's healthy (single-instance check)
```

> Note: the installer uses `sed` to substitute `__PROJECT_DIR__` in the plist template before
> copying it to `~/Library/LaunchAgents/`. Do **not** copy the plist manually — the placeholder
> will be left unresolved and the service will fail to spawn.

**Features:**
- `KeepAlive` — auto-restart on crash
- `ThrottleInterval` — min 10s between restarts (prevents crash loops)
- Logs to `logs/launchd.out.log` and `logs/launchd.err.log`

## Resilience

| Mechanism | Behavior |
|-----------|----------|
| Network retry | `getMe` retries 5× with exponential backoff (1s→30s) |
| Message retry | Handler retries 3× with linear backoff (1s, 2s, 3s) |
| Queue persistence | Unprocessed messages saved to `.queue/pending.json` |
| Process auto-restart | launchd `KeepAlive` restarts bot on crash |
| Handler isolation | Single message failure does not block queue |

## Development & releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev, the verification gates, and
the install/deploy/release flow. In short:

- **Dev:** `npm install && npm run setup && npm run dev`
- **Deploy this machine:** `/deploy` (Claude command) or re-run the installer
- **Cut a release:** `/release [patch|minor|major]` — gates, bumps, tags, pushes
  (CI publishes the GitHub Release), then redeploys + verifies this machine

## Requirements

- Node.js 22+ (`engines: node >=22`)
- tmux
- Claude Code CLI (`claude-yolo` or similar)
- _Optional, for voice:_ Apple Silicon Mac + [uv](https://docs.astral.sh/uv/) + ffmpeg (see [Voice transcription](#voice-transcription-optional))
