#!/bin/bash
# Control the tmux-claude-bot launchd service (macOS).
#   scripts/service.sh <status|pause|resume|restart|logs>
#     status   show whether the managed service + bot process are running
#     pause    stop it (bootout) - use before `npm run dev` to avoid a 409
#     resume   start it again (bootstrap)
#     restart  kick it (reloads latest code in ~/.tmux-claude-bot)
#     logs     tail the launchd stdout log
set -euo pipefail

LABEL="com.octopusgarage.tmux-claude-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOGDIR="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}/logs"

cmd="${1:-status}"
case "$cmd" in
  status)
    launchctl list | grep "$LABEL" || echo "service: not loaded"
    pgrep -fl "tmux-claude-bot.*(src/index.ts|dist/cli.js)" || echo "process: none running"
    ;;
  pause)
    if launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; then
      echo "paused (booted out) - resume with: npm run service:resume"
    else
      echo "already stopped / not loaded"
    fi
    ;;
  resume)
    [ -f "$PLIST" ] || { echo "plist not found: $PLIST (run: npm run service:install)" >&2; exit 1; }
    launchctl bootstrap "$DOMAIN" "$PLIST" && echo "resumed"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL" && echo "restarted"
    ;;
  logs)
    tail -f "$LOGDIR/launchd.out.log"
    ;;
  *)
    echo "usage: scripts/service.sh <status|pause|resume|restart|logs>" >&2
    exit 1
    ;;
esac
