import { type FlavorAlias, parseAgentAliases } from "../flavor-alias.js";

/**
 * Parse `codex-*` launcher aliases from rc text. Mirrors parseFlavorAliases but
 * for codex: only aliases whose binary is `codex` are kept, the signature is
 * {CODEX_HOME, null} (codex has no base-url env — it auths via auth.json).
 */
export function parseCodexFlavorAliases(rcText: string, home: string): FlavorAlias[] {
  return parseAgentAliases(rcText, home, {
    prefix: "codex-",
    binary: "codex",
    configEnv: "CODEX_HOME",
    baseUrlEnv: null,
  });
}
