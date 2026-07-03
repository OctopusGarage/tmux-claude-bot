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

## License

MIT
