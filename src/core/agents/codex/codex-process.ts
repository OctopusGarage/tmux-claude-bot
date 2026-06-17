import { basename } from "node:path";

/**
 * argv0-basename test for a codex process. Mirrors {@link isClaudeProcess}:
 * every codex flavor (codex-stella, codex-farmer, …) runs the same `codex`
 * binary differing only by env (CODEX_HOME), so argv0 is `codex` or an absolute
 * path ending in `/codex`. A bare wrapper named `codex-<flavor>` matches too.
 * Only argv0 counts — `vim codex.ts` is not a codex process.
 *
 * Leaf module (no project imports) so the registry and takeover can share it
 * without an import cycle.
 */
export function isCodexProcess(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  const name = basename(argv0);
  return name === "codex" || name.startsWith("codex-");
}
