#!/usr/bin/env sh

git_worktree_config_common_dir() {
  common_git_dir=$(git rev-parse --git-common-dir 2>/dev/null || true)
  if [ -z "$common_git_dir" ] && [ -d .git ]; then
    common_git_dir=.git
  fi
  if [ -n "$common_git_dir" ] && [ -d "$common_git_dir" ]; then
    printf '%s\n' "$common_git_dir"
  fi
}

git_worktree_config_checksum() {
  config_path=$1
  if [ ! -f "$config_path" ]; then
    printf 'missing'
    return 0
  fi
  if command -v cksum >/dev/null 2>&1; then
    cksum "$config_path" 2>/dev/null | awk '{print $1 ":" $2}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$config_path" 2>/dev/null | awk '{print $1}'
    return 0
  fi
  wc -c <"$config_path" 2>/dev/null | awk '{print $1}'
}

git_worktree_config_trace_file() {
  if [ -n "${TCB_GIT_CONFIG_TRACE_FILE:-}" ]; then
    printf '%s\n' "$TCB_GIT_CONFIG_TRACE_FILE"
    return 0
  fi
  common_git_dir=$(git_worktree_config_common_dir)
  if [ -n "$common_git_dir" ]; then
    printf '%s\n' "$common_git_dir/tcb-git-config-guard.log"
  fi
}

git_worktree_config_snapshot_line() {
  stage=$1
  common_git_dir=$(git_worktree_config_common_dir)
  if [ -z "$common_git_dir" ]; then
    printf 'ts=%s pid=%s stage=%s cwd=%s git_dir=none config=none checksum=none bare=unknown worktree=unknown env_GIT_DIR=%s env_GIT_WORK_TREE=%s env_GIT_INDEX_FILE=%s env_GIT_COMMON_DIR=%s\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$$" "$stage" "$(pwd -P 2>/dev/null || pwd)" \
      "${GIT_DIR:-}" "${GIT_WORK_TREE:-}" "${GIT_INDEX_FILE:-}" "${GIT_COMMON_DIR:-}"
    return 0
  fi

  config_path="$common_git_dir/config"
  checksum=$(git_worktree_config_checksum "$config_path")
  bare=$(git --git-dir="$common_git_dir" config --get core.bare 2>/dev/null || true)
  worktree=$(git --git-dir="$common_git_dir" config --get core.worktree 2>/dev/null || true)
  printf 'ts=%s pid=%s stage=%s cwd=%s git_dir=%s config=%s checksum=%s bare=%s worktree=%s env_GIT_DIR=%s env_GIT_WORK_TREE=%s env_GIT_INDEX_FILE=%s env_GIT_COMMON_DIR=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$$" "$stage" "$(pwd -P 2>/dev/null || pwd)" \
    "$common_git_dir" "$config_path" "$checksum" "${bare:-unset}" "${worktree:-unset}" \
    "${GIT_DIR:-}" "${GIT_WORK_TREE:-}" "${GIT_INDEX_FILE:-}" "${GIT_COMMON_DIR:-}"
}

git_worktree_config_append_trace() {
  line=$1
  trace_file=$(git_worktree_config_trace_file)
  if [ -n "$trace_file" ]; then
    printf '%s\n' "$line" >>"$trace_file" 2>/dev/null || true
  fi
}

git_worktree_config_checkpoint() {
  stage=$1
  line=$(git_worktree_config_snapshot_line "$stage")
  git_worktree_config_append_trace "$line"

  common_git_dir=$(git_worktree_config_common_dir)
  bare=
  worktree=
  if [ -n "$common_git_dir" ]; then
    bare=$(git --git-dir="$common_git_dir" config --get core.bare 2>/dev/null || true)
    worktree=$(git --git-dir="$common_git_dir" config --get core.worktree 2>/dev/null || true)
  fi
  cwd=$(pwd -P 2>/dev/null || pwd)
  if [ "$bare" = "true" ] ||
    [ -n "${GIT_DIR:-}" ] ||
    [ -n "${GIT_WORK_TREE:-}" ] ||
    { [ -n "$worktree" ] && [ "$worktree" != "$cwd" ]; }; then
    printf 'git worktree config guard: %s\n' "$line" >&2
  fi
}

restore_git_worktree_config() {
  common_git_dir=$(git_worktree_config_common_dir)
  if [ -z "$common_git_dir" ] || [ ! -d "$common_git_dir" ]; then
    return 0
  fi

  git --git-dir="$common_git_dir" config core.bare false 2>/dev/null || true
}

unset_git_local_env() {
  local_env_vars=$(git rev-parse --local-env-vars 2>/dev/null || true)
  if [ -z "$local_env_vars" ]; then
    local_env_vars='GIT_DIR
GIT_WORK_TREE
GIT_INDEX_FILE
GIT_OBJECT_DIRECTORY
GIT_ALTERNATE_OBJECT_DIRECTORIES
GIT_COMMON_DIR'
  fi

  # Git exports repository-local environment variables while running hooks.
  # Nested tests that create temporary repositories must rediscover their own
  # .git directories from cwd instead of inheriting the outer repository.
  for name in $local_env_vars; do
    unset "$name"
  done
}

git_worktree_config_guard_exit() {
  git_worktree_config_checkpoint "guard:exit-before-restore"
  restore_git_worktree_config
  git_worktree_config_checkpoint "guard:exit-after-restore"
  if [ "${TCB_GIT_CONFIG_EXIT_SETTLE_SECONDS:-0}" != "0" ]; then
    sleep "$TCB_GIT_CONFIG_EXIT_SETTLE_SECONDS" 2>/dev/null || true
    git_worktree_config_checkpoint "guard:exit-after-restore-settle"
    restore_git_worktree_config
  fi
}

install_git_worktree_config_guard() {
  git_worktree_config_checkpoint "guard:enter"
  restore_git_worktree_config
  git_worktree_config_checkpoint "guard:after-restore"
  unset_git_local_env
  git_worktree_config_checkpoint "guard:after-unset-env"
  trap 'git_worktree_config_guard_exit' EXIT HUP INT TERM
}
