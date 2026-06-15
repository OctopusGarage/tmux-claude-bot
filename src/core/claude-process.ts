import { basename } from "node:path";

/**
 * argv0-basename test for a claude process. Every flavor (claude-stella,
 * claude-ollama, …) runs the SAME `claude` binary and only differs by env
 * (CLAUDE_CONFIG_DIR), so at runtime argv0 is `claude` or an absolute path
 * ending in `/claude`. A bare wrapper script named `claude-<flavor>` is matched
 * too. An unrelated command that merely mentions claude in an argument
 * (`vim claude.ts`, `node build-claude.js`) is not — only argv0 counts.
 *
 * Leaf module (no project imports) so both the config resolver and takeover can
 * share it without forming an import cycle.
 */
export function isClaudeProcess(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  const name = basename(argv0);
  return name === "claude" || name.startsWith("claude-");
}
