#!/usr/bin/env sh
set -eu

payload=$(cat)

json_get() {
  jq -r "$1 // empty" 2>/dev/null <<EOF
$payload
EOF
}

tool_name=$(
  json_get '.tool_name'
)

case "$tool_name" in
  "" | "Bash" | "exec_command" | "functions.exec_command") ;;
  *) exit 0 ;;
esac

command=$(
  json_get '.tool_input.command // .tool_input.cmd // .input.command // .input.cmd // .arguments.command // .arguments.cmd'
)

[ -z "$command" ] && exit 0

normalized=$(
  printf '%s' "$command" |
    tr '[:upper:]' '[:lower:]' |
    tr '\n\r\t' '   ' |
    sed "s/[\"']//g; s/[[:space:]][[:space:]]*/ /g"
)

blocked_message='BLOCKED: refusing to execute a command that would set core.bare=true. This corrupts normal repository/worktree behavior. Use `git config --local core.bare false` for recovery instead.'

case "$normalized" in
  *".git/config"*)
    case "$normalized" in
      *"bare"*"true"* | *"true"*"bare"*)
        case "$normalized" in
          *">"* | *" tee "* | *" sed -i"* | *" perl -pi"*)
            printf '%s\n' "$blocked_message Direct .git/config bare writes are not allowed." >&2
            exit 2
            ;;
        esac
        ;;
    esac
    ;;
esac

if printf '%s\n' "$normalized" |
  grep -Eq '(^|[;&|()[:space:]])git([[:space:]][^;&|()]*)?[[:space:]]config([[:space:]][^;&|()]*)?[[:space:]]core[.]bare[[:space:]]+true($|[;&|()[:space:]])'; then
  printf '%s\n' "$blocked_message" >&2
  exit 2
fi

exit 0
