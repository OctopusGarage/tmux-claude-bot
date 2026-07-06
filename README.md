<a id="readme-top"></a>

# tmux-claude-bot

[![CI](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-enabled-2088FF?logo=github)](https://github.com/OctopusGarage/tmux-claude-bot/security/code-scanning)
[![Coverage](https://codecov.io/gh/OctopusGarage/tmux-claude-bot/branch/main/graph/badge.svg)](https://codecov.io/gh/OctopusGarage/tmux-claude-bot)
[![version](https://img.shields.io/github/package-json/v/OctopusGarage/tmux-claude-bot)](https://github.com/OctopusGarage/tmux-claude-bot/releases/latest)
[![npm](https://img.shields.io/npm/v/@octopusgarage/tmux-claude-bot?logo=npm)](https://www.npmjs.com/package/@octopusgarage/tmux-claude-bot)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![platform: macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-000000?logo=linux&logoColor=white)](#prerequisites)
[![Checked with Biome](https://img.shields.io/badge/Checked_with-Biome-60a5fa?logo=biome)](https://biomejs.dev)

<p align="center">
  A chat bot that drives a coding agent — <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> or <a href="https://github.com/openai/codex">OpenAI Codex</a> — inside tmux sessions — remote-control your local agent from <strong>Telegram and/or Feishu/Lark</strong>, with voice and text input. Supports <strong>multiple projects</strong>, each with its own tmux session. Pick one chat app or run both.
  <br />
  <br />
  <a href="docs/manual.md"><strong>Read the manual »</strong></a>
  <br />
  <br />
  <a href="#demo">View Demo</a>
  ·
  <a href="https://github.com/OctopusGarage/tmux-claude-bot/issues/new?template=bug_report.yml">Report Bug</a>
  ·
  <a href="https://github.com/OctopusGarage/tmux-claude-bot/issues/new?template=feature_request.yml">Request Feature</a>
</p>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#demo">Demo</a></li>
        <li><a href="#features">Features</a></li>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li><a href="#architecture">Architecture</a></li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#configuration">Configuration</a></li>
        <li><a href="#session-naming">Session Naming</a></li>
        <li><a href="#telegram-commands">Telegram Commands</a></li>
        <li><a href="#voice-transcription-optional">Voice transcription</a></li>
        <li><a href="#agent-running-detection">Agent Running Detection</a></li>
        <li><a href="#structured-logs">Structured Logs</a></li>
        <li><a href="#dashboard">Dashboard</a></li>
      </ul>
    </li>
    <li><a href="#deployment--resilience">Deployment &amp; Resilience</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

## About The Project

The bot **drives the agent's CLI like a user typing in tmux** (send-keys + screen-scrape) rather than calling an LLM API — so you get the full interactive session (Claude Code or OpenAI Codex), controlled remotely from a chat app. Run several projects at once (each in its own tmux session), switch between them from buttons, and talk to the agent with text or voice.

### Demo

| Telegram — keyboard & output | Voice transcription | Feishu/Lark |
|:---:|:---:|:---:|
| ![Telegram keyboard](.github/assets/demo-telegram-keyboard.png) | ![Voice](.github/assets/demo-voice.png) | ![Feishu](.github/assets/demo-feishu.png) |

### Features

- **Multi-project tmux sessions** — each project gets its own tmux session (`tmux_proj_<path>`)
- **Project switching** — create, switch, and remove projects via Telegram/Feishu commands & buttons
- **Feishu/Lark project groups** — bind a Feishu group to one workspace, so you switch projects by switching groups (no `/cd`); works without `@bot`. See [docs/commands.md](docs/commands.md)
- **Terminal UI (`tcb tui`)** — a keyboard-driven control panel at the PC: every session's status at a glance, send prompts, peek, and control — a local client of the same bot. See [docs/tui.md](docs/tui.md)
- **Drive it from an AI agent (`tcb` CLI + installable skill)** — one-shot `tcb` clients over the same control socket let an assistant in Claude Code / Codex operate the bot in natural language; `tcb skill install` bundles the operating skill (auto-installed on deploy). See [docs/manual.md](docs/manual.md)
- **Multiple start commands** — configure several agent launch commands (Claude or Codex, different env/model/API key) and pick which to start from a button
- **Real-time output streaming** — captures tmux pane and streams output to the chat
- **Queue-based execution** — prevents concurrent commands from interleaving
- **Idle detection** — polls tmux pane to detect when the agent is idle vs. running
- **Directory guard** — operations restricted to configured allowed directories

### Built With

- **Language / runtime** — [TypeScript](https://www.typescriptlang.org/) on [Node.js](https://nodejs.org) 22+
- **Chat adapters** — [grammY](https://grammy.dev) (Telegram) · [@larksuite/node-sdk](https://github.com/larksuite/node-sdk) (Feishu/Lark)
- **Core** — tmux · [Zod](https://zod.dev) (config) · [Commander](https://github.com/tj/commander.js) (CLI)
- **Build & test** — [tsup](https://tsup.egoist.dev) · [tsx](https://github.com/privatenumber/tsx) · [Vitest](https://vitest.dev) · [fast-check](https://fast-check.dev) · [Stryker](https://stryker-mutator.io) (mutation) · [Biome](https://biomejs.dev) (lint/format)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Architecture

```
   ┌──────────────┐         ┌──────────────┐         ┌──────────────────┐
   │   Telegram   │         │  Feishu/Lark │         │ Terminal TUI /   │
   │  app (user)  │         │  app (user)  │         │  tcb CLI (local) │
   └──────┬───────┘         └──────┬───────┘         └────────┬─────────┘
          │                        │                          │
   HTTPS long-poll          WebSocket (push)          unix-domain socket
   getUpdates / send        events + Open API         (local, NDJSON)
          │                        │                          │
   ┌──────▼────────────────────────▼──────────────────────────▼─────────┐
   │            tmux-claude-bot   (node dist/cli.js run)                │  launchd / systemd
   │                                                                    │  (single instance)
   │  ┌──────────────┐     ┌──────────────┐     ┌─────────────────────┐ │
   │  │  adapters/   │     │  adapters/   │     │  adapters/control   │ │  protocol glue:
   │  │  telegram    │     │  lark        │     │  unix-socket server │ │  receive / render /
   │  │  (grammY)    │     │ (@larksuite) │     │  ← TUI + tcb CLI    │ │  buttons & cards
   │  └──────┬───────┘     └──────┬───────┘     └──────────┬──────────┘ │
   │         └───────────────────┬┴────────────────────────┘            │
   │                      ┌──────▼───────┐                              │
   │                      │     core/    │  dispatch — meaning          │  protocol-agnostic
   │                      │   dispatch   │  queue    — serial + idle    │  (no platform code;
   │                      │   queue      │  agents/  — agent lifecycle  │   reused by every
   │                      │   agents/    │  tmux.ts  — tmux sessions    │   adapter)
   │                      │   tmux.ts    │                              │
   │                      └──────┬───────┘                              │
   └─────────────────────────────┼──────────────────────────────────────┘
                                 │
                  tmux send-keys │ ▲ capture-pane
                   (inject cmd)  │ │ (scrape output)
                                 ▼ │
                       ┌──────────────────────┐
                       │     tmux session      │  one per project
                       │  ┌────────────────┐   │
                       │  │  coding agent   │   │  interactive CLI,
                       │  │ (Claude / Codex)│   │  foreground in the pane
                       │  └────────────────┘   │
                       └──────────────────────┘
```

**Message round-trip:**

1. User sends a message in **Telegram / Feishu**, or drives the bot from the **Terminal TUI / `tcb` CLI**.
2. The matching **adapter** receives it (long-poll / WebSocket / unix socket) and normalizes it to a core command.
3. **`core/dispatch`** routes it; **`tmux.ts`** injects it into the project's tmux session via `send-keys`.
4. **Claude Code** processes it in the pane; the bot reads the result with `capture-pane`.
5. The adapter **renders the reply back** to the originating surface.

**Key points:**

- **Three client surfaces** — Telegram *polls* (HTTPS long-poll), Feishu *pushes* (persistent WebSocket), and the local **Terminal TUI / `tcb` CLI** talk over a unix-domain socket; each reply goes back out the surface it came from. All three funnel through the **same per-session queue**, so the TUI/CLI can't race the chat adapters.
- **One-way layering `adapters/ → core/ → shared/`** — `core/` knows nothing about any client, so adding Feishu — and later the local control transport (TUI/CLI) — was just another adapter; the tmux + agent machinery is fully reused.
- The bot **drives the Claude Code CLI like a user typing in tmux** (send-keys + screen-scrape), rather than calling an LLM API — which is why tmux sits in the middle.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

### Prerequisites

Runs on macOS (managed by launchd) and Linux (managed by a systemd `--user` service; `loginctl enable-linger` keeps it running on headless servers).

- Node.js 22+ (`engines: node >=22`)
- tmux
- Claude Code CLI (`claude-yolo` or similar)
- _Optional, for voice:_ Apple Silicon Mac + [uv](https://docs.astral.sh/uv/) + ffmpeg (see [Voice transcription](#voice-transcription-optional))

### Installation

**Two first-class install methods — both stand up the same managed launchd service** (guided wizard + auto-restart at `~/.tmux-claude-bot`). Pick either:

- **`curl … | bash`** (below) — the one-liner installer; nothing to install first beyond `node`/`tmux`.
- **[npm](#install-via-npm)** — `npm i -g @octopusgarage/tmux-claude-bot && tmux-claude-bot install`, with build provenance.

#### Install (macOS) — `curl | bash`

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

> [!TIP]
> Re-running the installer **updates code + dependencies and restarts the service while preserving your `.env` and runtime state** — a safe one-click update. Add Feishu later anytime with `npm run setup:lark`.

> [!NOTE]
> Prefer to clone first? `git clone … && cd tmux-claude-bot && ./install.sh` does the same thing in place.
> The install location defaults to `~/.tmux-claude-bot`; override it with `TMUX_CLAUDE_BOT_DIR=/path`.

#### Install with an AI assistant

Not comfortable on the command line? Copy this prompt to any AI assistant (ChatGPT,
Claude, Gemini, or an agent with shell access) — it downloads the release, reads the
bundled guide, and walks you through it:

```text
Install "tmux-claude-bot" on my machine for me (open-source; macOS or Linux). Download the latest
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

#### Install via npm

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

#### Manage

```bash
npm run service:install     # (re)install + start the launchd service
npm run doctor              # health check (incl. single-instance 409 guard)
npm run setup:reconfigure   # change token / authorized users / directories
npm run service:uninstall   # stop and remove the launchd service
```

#### First message

In Telegram: `/add_project ~/projects/myapp` then `/start`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

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
