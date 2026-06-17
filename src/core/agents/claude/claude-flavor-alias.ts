import { type FlavorAlias, parseAgentAliases } from "../flavor-alias.js";

/**
 * Parse `claude-*` launcher aliases from rc-file text. Mirrors
 * {@link parseCodexFlavorAliases} but for claude: only aliases whose binary is
 * `claude` are kept (so `claude-tmux="npx tsx …"` is ignored), and the signature
 * is {CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL}.
 */
export function parseClaudeFlavorAliases(rcText: string, home: string): FlavorAlias[] {
  return parseAgentAliases(rcText, home, {
    prefix: "claude-",
    binary: "claude",
    configEnv: "CLAUDE_CONFIG_DIR",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  });
}
