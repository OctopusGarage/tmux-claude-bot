/**
 * Infer which shell alias (claude-yolo / claude-stella / claude-ollama / …)
 * launched an orphan claude, so a takeover can resume by typing that ALIAS name
 * rather than a reconstructed command line. The alias carries the flavor's full
 * environment — base URL, model, and API key — from the user's rc file, so the
 * bot never has to read or print a secret to preserve the flavor.
 *
 * Flavors are distinguished by their environment, not their binary (they all run
 * the same `claude`). Several share CLAUDE_CONFIG_DIR=~/.claude and differ only by
 * ANTHROPIC_BASE_URL, so the signature is the pair {config dir, base url}.
 */

import { basename } from "node:path";

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? home + p.slice(1) : p;
}

export interface FlavorAlias {
  name: string;
  /** Absolute CLAUDE_CONFIG_DIR the alias sets, or null (⇒ default ~/.claude). */
  configDir: string | null;
  /** ANTHROPIC_BASE_URL the alias sets, or null. */
  baseUrl: string | null;
}

/**
 * Per-agent spec for {@link parseAgentAliases}: the alias-name prefix
 * (`claude-`/`codex-`), the launched binary (`claude`/`codex`), the env key the
 * alias sets its config dir via (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`), and the env
 * key for the base url (`ANTHROPIC_BASE_URL`, or null when the agent has none).
 */
export interface AgentAliasSpec {
  prefix: string;
  binary: string;
  configEnv: string;
  baseUrlEnv: string | null;
}

/**
 * Parse `<prefix>*` launcher aliases from rc-file text. Only aliases whose binary
 * matches `spec.binary` are kept (so `claude-tmux="npx tsx …"` is ignored), and
 * only the env assignments preceding the binary are read.
 */
export function parseAgentAliases(
  rcText: string,
  home: string,
  spec: AgentAliasSpec,
): FlavorAlias[] {
  const aliasRe = new RegExp(`alias\\s+(${spec.prefix}[\\w-]+)=(["'])(.*?)\\2`, "g");
  const out: FlavorAlias[] = [];
  for (const m of rcText.matchAll(aliasRe)) {
    const name = m[1];
    if (!name) continue;
    const env: Record<string, string> = {};
    let binary = "";
    for (const tok of (m[3] ?? "").trim().split(/\s+/)) {
      const assign = tok.match(/^([A-Za-z_]\w*)=(.*)$/);
      if (assign?.[1]) {
        env[assign[1]] = assign[2] ?? "";
      } else {
        binary = tok; // first non-assignment token is the launched binary
        break;
      }
    }
    if (basename(binary) !== spec.binary) continue; // not a launcher for this agent
    const configDir = env[spec.configEnv];
    out.push({
      name,
      configDir: configDir ? expandHome(configDir, home) : null,
      baseUrl: spec.baseUrlEnv ? (env[spec.baseUrlEnv] ?? null) : null,
    });
  }
  return out;
}

/**
 * The alias whose {config dir, base url} signature uniquely matches the orphan's
 * actual environment, or null when there's no match or it's ambiguous (caller
 * then falls back to a reconstructed command). An absent config dir on either
 * side normalizes to the default ~/.claude; an absent base url to "".
 */
export function matchFlavorAlias(
  aliases: FlavorAlias[],
  target: { configRoot: string; baseUrl: string | null },
  home: string,
): string | null {
  const defaultConfig = `${home}/.claude`;
  const tConfig = target.configRoot || defaultConfig;
  const tBase = target.baseUrl ?? "";
  const hits = aliases.filter(
    (a) => (a.configDir ?? defaultConfig) === tConfig && (a.baseUrl ?? "") === tBase,
  );
  return hits.length === 1 ? (hits[0]?.name ?? null) : null;
}
