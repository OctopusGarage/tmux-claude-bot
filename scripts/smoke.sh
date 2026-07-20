#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

anthropic_sdk="@anthropic-ai""/sdk"
google_sdk="@google/""(generative-ai|genai)"
google_client="Google""GenerativeAI|Google""GenAI"
ai_sdk="@ai-sdk/""(openai|anthropic|google)"
if rg -n --glob '!scripts/smoke.sh' \
  -e "from ['\"]openai['\"]" \
  -e "require\\(['\"]openai['\"]\\)" \
  -e "new OpenAI\\(" \
  -e "responses\\.create\\(" \
  -e "chat\\.completions\\.create\\(" \
  -e "$anthropic_sdk" \
  -e "new Anthropic\\(" \
  -e "anthropic\\.messages\\.create\\(" \
  -e "$google_sdk" \
  -e "new ($google_client)\\(" \
  -e "$ai_sdk" \
  -e "https?://api\\.(openai|anthropic)\\.com/v1/" \
  -e "https?://api\\.(deepseek|mistral)\\.com/v1/" \
  -e "https?://generativelanguage\\.googleapis\\.com/v1" \
  src scripts .env.example package.json package-lock.json >/dev/null
then
  printf 'smoke failed: direct model-provider API integration found; route AI work through the managed agent surface\n' >&2
  exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/tcb-smoke.XXXXXX")"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

export TCB_STATE_DIR="$tmp/state"
export TCB_ENV_FILE="$tmp/.env"
mkdir -p "$TCB_STATE_DIR"
touch "$TCB_ENV_FILE"

npm run build >/dev/null

node dist/cli.js --help >/dev/null
node dist/cli.js --version >/dev/null

for cmd in \
  service \
  dashboard \
  autopilot \
  sysload \
  sessions \
  projects \
  send \
  notify \
  prompt-translate \
  peek \
  open \
  adopt \
  control \
  attach \
  skill \
  recover \
  logs \
  batch \
  loop
do
  node dist/cli.js "$cmd" --help >/dev/null
done

node dist/cli.js loop skills --help >/dev/null
node dist/cli.js loop validate docs/examples/loop-skills-catalog.example.yml --json >/dev/null

fake_bin="$tmp/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/git" <<'SH'
#!/usr/bin/env sh
if [ "$1" = "ls-remote" ]; then
  printf '%s\trefs/heads/main\n' 'abcdefabcdefabcdefabcdefabcdefabcdefabcd'
  exit 0
fi
echo "unexpected git args: $*" >&2
exit 1
SH
chmod +x "$fake_bin/git"

loop_config="$tmp/loop.yml"
cat >"$loop_config" <<YAML
skills:
  applyCommand: "true"
  catalog:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      trackingRef: main
      platforms: [claude, codex]
      tags: [architecture]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
  approved: []
projects:
  - id: smoke-project
    name: Smoke Project
    path: "$ROOT"
    agent: codex
    goal: Smoke-test Loop Engineering CLI paths.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: "test -f package.json && printf assessment-ok"
    execution:
      agent: false
    allowedActions: [tests]
YAML

PATH="$fake_bin:$PATH" node dist/cli.js loop skills refresh "$loop_config" --write --json >/dev/null
node dist/cli.js loop skills sync "$loop_config" --json >/dev/null
node dist/cli.js loop run "$loop_config" smoke-project --json >/dev/null

printf 'smoke ok\n'
