#!/bin/bash
set -euo pipefail

# Project-managed install of Argos Translate for optional voice prompt translation.
# Reuses the project-local .venv so it can sit beside mlx-whisper without requiring
# a separate Python environment.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_DIR/.venv"
PYTHON="$VENV_DIR/bin/python"

# Locate uv. When triggered from a managed service, PATH may not include ~/.local/bin.
UV_BIN="$(command -v uv 2>/dev/null || true)"
if [ -z "$UV_BIN" ]; then
  for cand in "$HOME/.local/bin/uv" "/opt/homebrew/bin/uv" "/usr/local/bin/uv"; do
    if [ -x "$cand" ]; then UV_BIN="$cand"; break; fi
  done
fi
if [ -z "$UV_BIN" ]; then
  echo "[install-argos-translate] uv not found. Install it first:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

echo "[install-argos-translate] creating venv at $VENV_DIR"
if [ ! -x "$PYTHON" ]; then
  "$UV_BIN" venv "$VENV_DIR"
else
  echo "[install-argos-translate] reusing existing venv at $VENV_DIR"
fi

echo "[install-argos-translate] installing argostranslate"
"$UV_BIN" pip install --python "$PYTHON" "argostranslate==1.11.0"

echo "[install-argos-translate] downloading pinned zh -> en model package"
"$PYTHON" - <<'PY'
import argostranslate.package
import argostranslate.translate

argostranslate.package.update_package_index()
available_packages = argostranslate.package.get_available_packages()
package_to_install = next(
    pkg for pkg in available_packages if pkg.from_code == "zh" and pkg.to_code == "en"
)
model_path = package_to_install.download()
print(f"[install-argos-translate] downloaded {model_path}")
argostranslate.package.install_from_path(model_path)

sample = argostranslate.translate.translate("你好", "zh", "en").strip()
if not sample:
    raise SystemExit("zh -> en smoke test produced an empty translation")
print(f"[install-argos-translate] smoke test: 你好 -> {sample}")
PY

echo "[install-argos-translate] done."
echo "[install-argos-translate] Set these in your .env:"
echo "  PROMPT_TRANSLATE_MODE=argos"
echo "  PROMPT_TRANSLATE_FROM=zh"
echo "  PROMPT_TRANSLATE_TO=en"
echo "  ARGOS_TRANSLATE_PYTHON=$PYTHON"
