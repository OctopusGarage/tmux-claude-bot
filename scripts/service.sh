#!/bin/bash
# Control the tmux-claude-bot managed service.
#   macOS:  launchd agent       Linux: systemd --user unit
#   scripts/service.sh <status|running|pause|resume|restart|logs|dev|prod>
#     running  exit 0 if the managed service is loaded/active (quiet; for dev.sh)
set -euo pipefail

LABEL="com.octopusgarage.tmux-claude-bot"
UNIT="tmux-claude-bot"
LOGDIR="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}/logs"
PROC_PAT="tmux-claude-bot.*(src/index.ts|dist/cli.js)"
USAGE="usage: scripts/service.sh <status|running|pause|resume|restart|logs|dev|prod>"
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
    dev|prod) echo "dev/prod switch is macOS-only for now" >&2; exit 1 ;;
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
  dev)
    REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
    "$REPO_DIR/scripts/install-launchd.sh" --dev
    echo "switched to DEV (hot-reload from $REPO_DIR)"
    ;;
  prod)
    PROD_DIR="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}"
    "$PROD_DIR/scripts/install-launchd.sh"
    echo "switched to PROD (bundled dist at $PROD_DIR)"
    ;;
  *)
    echo "$USAGE" >&2
    exit 1
    ;;
esac
