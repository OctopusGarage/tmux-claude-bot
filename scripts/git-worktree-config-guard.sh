#!/usr/bin/env sh

restore_git_worktree_config() {
  common_git_dir=$(git rev-parse --git-common-dir 2>/dev/null || true)
  if [ -z "$common_git_dir" ] && [ -d .git ]; then
    common_git_dir=.git
  fi
  if [ -z "$common_git_dir" ] || [ ! -d "$common_git_dir" ]; then
    return 0
  fi

  git --git-dir="$common_git_dir" config core.bare false 2>/dev/null || true
}

install_git_worktree_config_guard() {
  restore_git_worktree_config
  trap 'restore_git_worktree_config' EXIT HUP INT TERM
}
