#!/bin/bash
# One-line installer for tmux-claude-bot (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/OctopusGarage/tmux-claude-bot/main/install.sh | bash
#
# Or run ./install.sh from a local clone. Idempotent: re-running updates deps
# and re-runs the launchd install. Your .env is gitignored and never touched.
#
# Installs the latest stable release by default. Pin or track main:
#   TMUX_CLAUDE_BOT_VERSION=v0.1.0 curl -fsSL .../install.sh | bash
#   TMUX_CLAUDE_BOT_VERSION=main   curl -fsSL .../install.sh | bash
set -euo pipefail

REPO="https://github.com/OctopusGarage/tmux-claude-bot.git"
INSTALL_DIR="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}"

info() { printf '\033[1;34m=>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; }

case "$(uname)" in
  Darwin|Linux) ;;
  *) err "tmux-claude-bot supports macOS and Linux only."; exit 1 ;;
esac
command -v git  >/dev/null 2>&1 || { err "git not found - run: xcode-select --install"; exit 1; }

# Determine mode: local clone (run AS a file from a checkout) vs remote curl|bash.
# IMPORTANT: derive SELF_DIR from BASH_SOURCE[0] ONLY, never $0/cwd. When piped
# (`bash -c "$(curl ...)"`) BASH_SOURCE is empty -> SELF_DIR stays empty -> remote
# mode, no matter the working directory. Falling back to the cwd here is the
# footgun that made `curl | bash` from inside a clone install in-place (and strip
# its devDeps). A deploy intent (TMUX_CLAUDE_BOT_VERSION set) also forces remote.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi
MATERIALIZE=0
if [ -n "${TCB_MATERIALIZE_FROM:-}" ]; then
  # Materialize mode: provision the managed runtime from an already-built copy
  # (the installed npm package) instead of downloading. Used by `tmux-claude-bot
  # install` so an `npm i -g` install can stand up the launchd service from a
  # stable ~/.tmux-claude-bot, without re-downloading or rebuilding. dist is
  # prebuilt in the package, so the deps step below only installs runtime deps.
  MATERIALIZE=1
  PROJECT_DIR="$INSTALL_DIR"
  info "Materializing managed runtime at $PROJECT_DIR (from $TCB_MATERIALIZE_FROM)..."
  mkdir -p "$PROJECT_DIR"
  # A materialized install is not a git checkout - drop any stale .git from a
  # prior `main` clone (rsync --delete can't reliably remove read-only git objects).
  rm -rf "$PROJECT_DIR/.git"
  if [ "$TCB_MATERIALIZE_FROM" != "$PROJECT_DIR" ]; then
    rsync -a --delete \
      --exclude='/state' --exclude='/logs' --exclude='node_modules' \
      --exclude='.bot.pid' --exclude='.running' --exclude='.instance.lock' \
      --exclude='.env' --exclude='.current_project' --exclude='.queue' \
      --exclude='recent_projects.txt' --exclude='media' --exclude='status-snapshots' \
      --exclude='group_bindings.json' --exclude='workspaces.json' --exclude='auth.json' \
      --exclude='settings.json' --exclude='free_projects.json' \
      --exclude='session_path_map.json' --exclude='session_agent_map.json' \
      --exclude='session_live_id_map.json' --exclude='session_task_time.json' \
      --exclude='lark_reply_target_map.json' --exclude='reply_target_map.json' \
      "$TCB_MATERIALIZE_FROM/" "$PROJECT_DIR/"
  fi
elif [ -z "${TMUX_CLAUDE_BOT_VERSION:-}" ] && [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/package.json" ] && grep -qE '"(@[^"/]+/)?tmux-claude-bot"' "$SELF_DIR/package.json" 2>/dev/null; then
  PROJECT_DIR="$SELF_DIR"
  info "Local install at $PROJECT_DIR"
else
  PROJECT_DIR="$INSTALL_DIR"
  # Resolve which version to install.
  VERSION="${TMUX_CLAUDE_BOT_VERSION:-}"
  if [ -z "$VERSION" ]; then
    # Default: latest published release; fall back to main if there are none.
    VERSION="$(curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --max-time 30 \
      "https://api.github.com/repos/OctopusGarage/tmux-claude-bot/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name"[^"]*"([^"]+)".*/\1/' || true)"
    [ -z "$VERSION" ] && VERSION="main"
  fi

  if [ "$VERSION" = "main" ]; then
    if [ -d "$PROJECT_DIR/.git" ]; then
      info "Updating existing install at $PROJECT_DIR (main)..."
      git -C "$PROJECT_DIR" pull --ff-only || {
        err "Could not fast-forward $PROJECT_DIR. Your .env is preserved. To reset:"
        err "  git -C \"$PROJECT_DIR\" fetch origin && git -C \"$PROJECT_DIR\" reset --hard origin/main"
        exit 1
      }
    elif [ -d "$PROJECT_DIR" ] && [ -n "$(ls -A "$PROJECT_DIR" 2>/dev/null)" ]; then
      err "$PROJECT_DIR exists but is not a git checkout (a versioned/tarball install?)."
      err "Remove it (rm -rf \"$PROJECT_DIR\") and re-run to switch to a git-tracked main install."
      exit 1
    else
      info "Cloning main into $PROJECT_DIR..."
      git clone "$REPO" "$PROJECT_DIR"
    fi
  else
    # Versioned install: download the lean release asset (source + scripts +
    # manifests only) published by the Release workflow - NOT the full source
    # archive with tests/CI/lint/docs.
    info "Installing version $VERSION (release tarball)..."
    mkdir -p "$PROJECT_DIR"
    # A versioned/tarball install is not a git checkout - drop any stale .git from
    # a prior `main` clone (rsync --delete can't reliably remove read-only objects).
    rm -rf "$PROJECT_DIR/.git"
    tmpdir="$(mktemp -d)"
    curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --max-time 300 \
      "https://github.com/OctopusGarage/tmux-claude-bot/releases/download/$VERSION/tmux-claude-bot-$VERSION.tar.gz" \
      | tar xz -C "$tmpdir" --strip-components=1 || {
        err "Could not download/extract the release asset for '$VERSION'. Check it exists at:"
        err "  https://github.com/OctopusGarage/tmux-claude-bot/releases"
        rm -rf "$tmpdir"; exit 1
      }
    # Mirror the lean tree into the install dir, deleting stale files - so a full
    # source-archive install (tests/CI/lint) leaves no clutter and removed files
    # don't orphan on update (.git was already dropped above). Runtime state,
    # deps, and logs are excluded from deletion and preserved.
    rsync -a --delete \
      --exclude='/state' --exclude='/logs' --exclude='node_modules' \
      --exclude='.bot.pid' --exclude='.running' --exclude='.instance.lock' \
      --exclude='.env' --exclude='.current_project' --exclude='.queue' \
      --exclude='recent_projects.txt' --exclude='media' --exclude='status-snapshots' \
      --exclude='group_bindings.json' --exclude='workspaces.json' --exclude='auth.json' \
      --exclude='settings.json' --exclude='free_projects.json' \
      --exclude='session_path_map.json' --exclude='session_agent_map.json' \
      --exclude='session_live_id_map.json' --exclude='session_task_time.json' \
      --exclude='lark_reply_target_map.json' --exclude='reply_target_map.json' \
      "$tmpdir/" "$PROJECT_DIR/"
    rm -rf "$tmpdir"
  fi
fi
cd "$PROJECT_DIR"

# State (and .env) live in the state/ subdir, kept out of the deploy's
# `rsync --delete` (see scripts/launchd-wrapper.sh). Pin it so the setup wizard
# and any CLI below write/read .env there, matching the running service. The
# boot-time migrateLegacyStateDir() relocates a legacy root-level .env/state.
export TCB_STATE_DIR="$PROJECT_DIR/state"
export TCB_ENV_FILE="$PROJECT_DIR/state/.env"

# Prerequisites.
command -v node >/dev/null 2>&1 || { err "node not found - install via nvm: https://github.com/nvm-sh/nvm"; exit 1; }
command -v tmux >/dev/null 2>&1 || warn "tmux not found - install it (macOS: brew install tmux | Debian/Ubuntu: sudo apt install tmux)"
command -v claude >/dev/null 2>&1 || warn "Claude Code CLI not found - see https://docs.anthropic.com/en/docs/claude-code (or set CLAUDE_START_COMMAND)."

if [ "$MATERIALIZE" = 1 ]; then
  # Materialize mode ships a prebuilt dist - only runtime deps are needed.
  info "Installing runtime dependencies..."
  HUSKY=0 npm install --omit=dev
else
  # Full install (dev deps included) so the tsup build can run, then build the
  # bundled dist the launchd service runs, then prune dev deps back out. Skip
  # husky - end users need no git hooks; tarball installs have no .git anyway.
  info "Installing dependencies..."
  HUSKY=0 npm ci || HUSKY=0 npm install
  info "Building..."
  npm run build
  info "Pruning dev dependencies..."
  HUSKY=0 npm prune --omit=dev
fi

# Global launchers so the documented commands ('tmux-claude-bot tui', 'tcb tui',
# 'tcb dashboard', ...) work from anywhere - a thin wrapper that execs the bundled
# CLI. Same ~/.local/bin launcher pattern as the sibling net-auto-switch install.
# Two names: the full 'tmux-claude-bot' and the short 'tcb' the docs use.
BIN_DIR="$HOME/.local/bin"
NODE_BIN="$(command -v node)"
mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/tmux-claude-bot" <<EOF_RUNNER
#!/usr/bin/env bash
set -euo pipefail
# Pin to THIS install's state dir (the launchd/systemd service uses the same
# state/ subdir) so the CLI always reaches the managed bot's control socket,
# regardless of any stray TCB_STATE_DIR in the caller's environment.
export TCB_STATE_DIR="$PROJECT_DIR/state"
exec "$NODE_BIN" "$PROJECT_DIR/dist/cli.js" "\$@"
EOF_RUNNER
chmod +x "$BIN_DIR/tmux-claude-bot"
ln -sf tmux-claude-bot "$BIN_DIR/tcb"
info "Installed launchers 'tcb' and 'tmux-claude-bot' in $BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "Add $BIN_DIR to your PATH to use them globally:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# Guided setup (read prompts from the terminal even when piped via curl). Driven
# through the built CLI, not `npm run setup` (= tsx src/...): the materialized npm
# package ships dist only, no src.
# Migrate a legacy root-level .env into state/ before the check, so an existing
# install isn't re-prompted for setup after the state/ split.
[ -f .env ] && [ ! -f "$TCB_ENV_FILE" ] && { mkdir -p "$PROJECT_DIR/state"; mv .env "$TCB_ENV_FILE"; }
if [ ! -f "$TCB_ENV_FILE" ]; then
  info "Starting guided setup..."
  if [ -e /dev/tty ]; then node dist/cli.js setup < /dev/tty; else node dist/cli.js setup --yes; fi
else
  info ".env already present - skipping setup (run 'node dist/cli.js setup --reconfigure' to change it)."
fi

# Service.
if [ -z "${TCB_SKIP_SERVICE:-}" ]; then
  info "Installing service..."
  scripts/install-service.sh
else
  info "TCB_SKIP_SERVICE set - skipping service registration."
fi

# Default AI tool surfaces live under the bot-owned Home Operator workspace;
# this command also removes stale global skill copies. It does not mutate the
# user's private Claude/Codex global config.
if [ -z "${TCB_SKIP_AI_TOOLS:-}" ] && [ -z "${TCB_SKIP_MCP:-}" ]; then
  info "Installing default AI tool surfaces..."
  node dist/cli.js ai-tools install || info "AI tool surface install skipped (non-fatal)."
else
  info "TCB_SKIP_AI_TOOLS/TCB_SKIP_MCP set - skipping AI tool surface install."
fi

info "Done. Installed at $PROJECT_DIR"
info "Terminal UI:     tcb tui"
info "Other commands (global - no cd needed; 'tmux-claude-bot' works too):"
info "  Health check:  tcb doctor"
info "  MCP profiles:  tcb mcp install"
info "  Skills:        tcb skill status   (optional global copy: tcb skill install --scope global)"
info "  Reconfigure:   tcb setup --reconfigure"
info "  Add Feishu:    tcb setup:lark   (scan a QR; works with or instead of Telegram)"
info "  Uninstall:     tcb service uninstall"
info "  Live logs:     tail -f $PROJECT_DIR/logs/launchd.out.log $PROJECT_DIR/logs/launchd.err.log"
