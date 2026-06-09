#!/bin/bash
# Local dev: tsx watch, proxy-free. Warns if the managed launchd service is running
# with the SAME bot token (both would long-poll Telegram and hit a 409 Conflict).
set -euo pipefail
cd "$(dirname "$0")"

LABEL="com.octopusgarage.tmux-claude-bot"
DEPLOY_ENV="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}/.env"
if launchctl list "$LABEL" >/dev/null 2>&1 && [ -f .env ] && [ -f "$DEPLOY_ENV" ]; then
  dev_tok="$(grep -E '^BOT_TOKEN=' .env | head -1 || true)"
  prod_tok="$(grep -E '^BOT_TOKEN=' "$DEPLOY_ENV" | head -1 || true)"
  if [ -n "$dev_tok" ] && [ "$dev_tok" = "$prod_tok" ]; then
    echo "! The managed service is running with the SAME bot token -> Telegram will 409."
    echo "  Pause it:        npm run service:pause   (resume later: npm run service:resume)"
    echo "  Or use a dev bot: npm run setup:reconfigure  (set a separate BOT_TOKEN here)"
    echo ""
  fi
fi

HTTP_PROXY= HTTPS_PROXY= npm run dev
