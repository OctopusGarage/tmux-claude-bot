# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub Private Vulnerability Reporting](https://github.com/OctopusGarage/tmux-claude-bot/security/advisories/new) to submit a report privately. We will acknowledge the report within 7 days and keep you informed as we work on a fix.

## Scope

This bot runs as a personal daemon on your own machine and is not a shared service. Key security properties:

- Only `TELEGRAM_ALLOWED_USER_IDS` / `LARK_ALLOWED_OPEN_IDS` (set in `.env`) can issue commands
- The bot opens no inbound ports — it uses Telegram/Feishu long-polling only
- All credentials live in a local `.env` file (mode 0600, gitignored)
