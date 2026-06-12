#!/bin/bash
# One-line installer for tmux-claude-bot (macOS).
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

[ "$(uname)" = "Darwin" ] || { err "tmux-claude-bot is macOS-only (launchd)."; exit 1; }
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
  if [ "$TCB_MATERIALIZE_FROM" != "$PROJECT_DIR" ]; then
    rsync -a --delete \
      --exclude='.env' --exclude='.current_project' --exclude='recent_projects.txt' \
      --exclude='session_path_map.json' --exclude='.queue' --exclude='logs' \
      --exclude='.bot.pid' --exclude='node_modules' \
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
    tmpdir="$(mktemp -d)"
    curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --max-time 300 \
      "https://github.com/OctopusGarage/tmux-claude-bot/releases/download/$VERSION/tmux-claude-bot-$VERSION.tar.gz" \
      | tar xz -C "$tmpdir" --strip-components=1 || {
        err "Could not download/extract the release asset for '$VERSION'. Check it exists at:"
        err "  https://github.com/OctopusGarage/tmux-claude-bot/releases"
        rm -rf "$tmpdir"; exit 1
      }
    # Mirror the lean tree into the install dir, deleting stale files - so a prior
    # git-clone (.git) or full source-archive install (tests/CI/lint) leaves no
    # clutter, and removed files don't orphan on update. Runtime state, deps, and
    # logs are excluded from deletion and preserved.
    rsync -a --delete \
      --exclude='.env' --exclude='.current_project' --exclude='recent_projects.txt' \
      --exclude='session_path_map.json' --exclude='.queue' --exclude='logs' \
      --exclude='.bot.pid' --exclude='node_modules' \
      "$tmpdir/" "$PROJECT_DIR/"
    rm -rf "$tmpdir"
  fi
fi
cd "$PROJECT_DIR"

# Prerequisites.
command -v node >/dev/null 2>&1 || { err "node not found - install via nvm: https://github.com/nvm-sh/nvm"; exit 1; }
command -v tmux >/dev/null 2>&1 || warn "tmux not found - install with: brew install tmux"
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

# Guided setup (read prompts from the terminal even when piped via curl). Driven
# through the built CLI, not `npm run setup` (= tsx src/...): the materialized npm
# package ships dist only, no src.
if [ ! -f .env ]; then
  info "Starting guided setup..."
  if [ -e /dev/tty ]; then node dist/cli.js setup < /dev/tty; else node dist/cli.js setup --yes; fi
else
  info ".env already present - skipping setup (run 'node dist/cli.js setup --reconfigure' to change it)."
fi

# Service.
if [ -z "${TCB_SKIP_SERVICE:-}" ]; then
  info "Installing launchd service..."
  scripts/install-launchd.sh
else
  info "TCB_SKIP_SERVICE set - skipping launchd registration."
fi

info "Done. Installed at $PROJECT_DIR"
info "These commands must run from the install dir (cd shown):"
info "  Health check:  cd $PROJECT_DIR && node dist/cli.js doctor"
info "  Reconfigure:   cd $PROJECT_DIR && node dist/cli.js setup --reconfigure"
info "  Add Feishu:    cd $PROJECT_DIR && node dist/cli.js setup:lark   (scan a QR; works with or instead of Telegram)"
info "  Uninstall:     cd $PROJECT_DIR && node dist/cli.js service uninstall"
info "  Live logs:     tail -f $PROJECT_DIR/logs/launchd.err.log   (absolute path; runs from anywhere)"
