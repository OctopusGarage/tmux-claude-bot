#!/bin/bash
# Control the tmux-claude-bot managed service.
#   macOS:  launchd agent       Linux: systemd --user unit
#   scripts/service.sh <status|running|pause|resume|restart|logs>
#     running  exit 0 if the managed service is loaded/active (quiet; for dev.sh)
set -euo pipefail

LABEL="com.octopusgarage.tmux-claude-bot"
UNIT="tmux-claude-bot"
LOGDIR="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}/logs"
PROC_PAT="tmux-claude-bot.*(src/index.ts|dist/cli.js)"
USAGE="usage: scripts/service.sh <status|running|pause|resume|restart|logs>"
cmd="${1:-status}"

if [ "$(uname)" = "Linux" ]; then
  case "$cmd" in
    status)
      systemctl --user status "$UNIT" --no-pager || true
      pgrep -fl "$PROC_PAT" || echo "process: none running"
      ;;
    running) systemctl --user is-active --quiet "$UNIT" ;;
    pause)   systemctl --user stop "$UNIT" && echo "paused (stopped)" ;;
    resume)  systemctl --user start "$UNIT" && echo "resumed" ;;
    restart) systemctl --user restart "$UNIT" && echo "restarted" ;;
    logs)    journalctl --user -u "$UNIT" -f ;;
    *) echo "$USAGE" >&2; exit 1 ;;
  esac
  exit 0
fi

# macOS / launchd
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
case "$cmd" in
  status)
    launchctl list | grep "$LABEL" || echo "service: not loaded"
    pgrep -fl "$PROC_PAT" || echo "process: none running"
    ;;
  running) launchctl list "$LABEL" >/dev/null 2>&1 ;;
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
    tail -f "$LOGDIR/launchd.out.log" "$LOGDIR/launchd.err.log"
    ;;
  *)
    echo "$USAGE" >&2
    exit 1
    ;;
esac
