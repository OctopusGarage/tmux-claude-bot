# GitHub Project Polish — Design Spec

**Date:** 2026-06-11  
**Scope:** Make the public GitHub repo look professional, elegant, and reliable.  
**Approach:** Full Professional Polish (Approach B)

---

## Goals

- Every standard open-source "professional checklist" item is covered
- First-time visitors immediately understand what the project does and trust it
- Contributors find clear templates and processes

## Out of scope

- Custom Social Preview / OG image (requires design work outside code)
- Mermaid architecture diagram (ASCII is already clear; marginal ROI)
- README language change (stays pure English)

---

## Section 1: LICENSE + GitHub Metadata

### LICENSE file

- Add `LICENSE` (MIT) at repo root
- Copyright line: `Copyright (c) 2026 OctopusGarage`

### package.json

- Add `"license": "MIT"`
- Remove `"private": true` (public tool; `private` blocks shields.io npm badge lookups)

### GitHub repo metadata (via `gh` CLI)

| Field | New value |
|-------|-----------|
| Description | `Remote-control Claude Code from Telegram or Feishu/Lark — send prompts to tmux-hosted Claude sessions, get rich replies, transcribe voice messages. macOS, one-line install.` |
| Homepage | `https://github.com/OctopusGarage/tmux-claude-bot/releases/latest` |
| Topics | existing 5 + `feishu` `lark` `voice` `macos` `claude-ai` `ai-assistant` |

---

## Section 2: Codecov Integration + README Badges

### CI workflow (`.github/workflows/ci.yml`)

Add after the `vitest run --coverage` step:

```yaml
- uses: codecov/codecov-action@v5
  with:
    fail_ci_if_error: false
```

No token needed for public repos. `fail_ci_if_error: false` prevents Codecov outages from blocking CI.

### README badge row

Insert after the `# tmux-claude-bot` heading, before the first sentence:

```markdown
[![CI](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/OctopusGarage/tmux-claude-bot/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/OctopusGarage/tmux-claude-bot/branch/main/graph/badge.svg)](https://codecov.io/gh/OctopusGarage/tmux-claude-bot)
[![npm version](https://img.shields.io/github/package-json/v/OctopusGarage/tmux-claude-bot)](https://github.com/OctopusGarage/tmux-claude-bot/releases/latest)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
```

5 badges: CI status, coverage, version, Node requirement, license.

---

## Section 3: Demo Screenshots

### Asset storage

Commit 4 desensitized screenshots to `.github/assets/`:

| File | Source | Shows |
|------|--------|-------|
| `demo-telegram-keyboard.png` | IMG_7833 | Full keyboard + Claude output in Telegram |
| `demo-telegram-chat.png` | IMG_7831 | Conversation flow with project context |
| `demo-voice.png` | IMG_7832 | Voice message transcription |
| `demo-feishu.png` | IMG_7830 | Feishu/Lark Chinese UI |

### README Demo section

Add `## Demo` between `## Features` and `## Architecture`:

```markdown
## Demo

| Telegram — keyboard & output | Voice transcription | Feishu/Lark |
|:---:|:---:|:---:|
| ![Telegram keyboard](.github/assets/demo-telegram-keyboard.png) | ![Voice](.github/assets/demo-voice.png) | ![Feishu](.github/assets/demo-feishu.png) |
```

Three columns show three core scenarios. Fourth screenshot (IMG_7831) kept as backup — content overlaps with keyboard demo.

---

## Section 4: Issue Templates, PR Template, SECURITY.md

### `.github/ISSUE_TEMPLATE/bug_report.yml`

Structured fields:
- OS / Node version
- Steps to reproduce (numbered list)
- Expected vs actual behaviour
- Relevant logs (`logs/launchd.err.log`)
- Whether `npm run doctor` was run

### `.github/ISSUE_TEMPLATE/feature_request.yml`

Fields:
- Use case description
- Desired solution
- Alternatives considered

### `.github/pull_request_template.md`

Concise checklist aligned with CONTRIBUTING.md:
- One-line summary of change
- Verification checklist: `npm test` / `npm run lint` / `npm run knip`
- Whether `.env` variables changed

### `SECURITY.md` (repo root)

- Do not report security issues in public GitHub issues
- Use GitHub Private Vulnerability Reporting
- Response commitment: acknowledge within 7 days

---

## File change summary

| File | Action |
|------|--------|
| `LICENSE` | Create |
| `SECURITY.md` | Create |
| `.github/assets/demo-*.png` | Create (4 files) |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Create |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Create |
| `.github/pull_request_template.md` | Create |
| `.github/workflows/ci.yml` | Edit (add Codecov step) |
| `README.md` | Edit (add badges + Demo section) |
| `package.json` | Edit (add license, remove private) |
| GitHub repo metadata | Update via `gh` CLI (description, homepage, topics) |
