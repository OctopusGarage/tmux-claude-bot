#!/bin/bash
set -euo pipefail

# Project-managed install of mlx-whisper (optional voice transcription) via uv.
# Creates a project-local .venv and installs the pinned requirements.txt, so the
# dependency is reproducible and owned by the repo instead of a manual machine
# install. MLX_WHISPER_BIN in .env should point at the binary this prints.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_DIR/.venv"
BIN="$VENV_DIR/bin/mlx_whisper"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "[install-whisper] mlx-whisper requires Apple Silicon (macOS arm64). Aborting." >&2
  exit 1
fi

# Locate uv. When triggered in-bot (launchd), PATH may not include ~/.local/bin
# where uv's installer puts it, so probe the common locations too.
UV_BIN="$(command -v uv 2>/dev/null || true)"
if [ -z "$UV_BIN" ]; then
  for cand in "$HOME/.local/bin/uv" "/opt/homebrew/bin/uv" "/usr/local/bin/uv"; do
    if [ -x "$cand" ]; then UV_BIN="$cand"; break; fi
  done
fi
if [ -z "$UV_BIN" ]; then
  echo "[install-whisper] uv not found. Install it first:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[install-whisper] WARNING: ffmpeg not on PATH; mlx_whisper needs it to decode audio." >&2
  echo "  brew install ffmpeg" >&2
fi

echo "[install-whisper] creating venv at $VENV_DIR"
"$UV_BIN" venv "$VENV_DIR"

echo "[install-whisper] installing pinned requirements"
"$UV_BIN" pip install --python "$VENV_DIR/bin/python" -r "$PROJECT_DIR/requirements.txt"

if [ ! -x "$BIN" ]; then
  echo "[install-whisper] expected binary not found at $BIN" >&2
  exit 1
fi

echo "[install-whisper] done."
echo "[install-whisper] Set this in your .env:"
echo "  MLX_WHISPER_BIN=$BIN"
