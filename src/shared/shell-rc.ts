/** Shell rc files mined for `claude-*` / `codex-*` launcher aliases. Shared by the
 * takeover probe (async read) and bootstrap's activity-watch-root derivation (sync
 * read) so the two never drift on which files alias discovery looks at. */
export const SHELL_RC_FILES = [
  ".zshrc",
  ".bashrc",
  ".zprofile",
  ".bash_profile",
  ".profile",
  ".aliases",
  ".zsh_aliases",
] as const;
