import { homedir } from "node:os";
import { DEFAULT_CONFIG_ROOT } from "./claude/claude-history.js";

// YOLO mode (skips every edit/command confirmation). We never ADD this on the
// user's behalf — we only carry it over when the original process already had it,
// so a takeover can't silently escalate a cautious session's permissions.
export const SKIP_PERMS = "--dangerously-skip-permissions";
/** Codex's auto-approve flag — its equivalent of claude's skip-permissions. */
export const CODEX_SKIP_PERMS = "--yolo";

/** Codex's default config root — CODEX_HOME is prefixed only for a non-default one. */
export const DEFAULT_CODEX_ROOT = `${homedir()}/.codex`;

/**
 * Build the shell line typed into the tmux pane to resume or start codex.
 * When `sessionId` is provided, appends `resume <id>`.
 *
 * - With a matched flavor `aliasName`, that name already carries CODEX_HOME +
 *   flags (model/yolo) from the rc file, so we type it bare — never doubling up
 *   the env or the yolo flag.
 * - Otherwise the bare `codex` bin: prefix `CODEX_HOME=<root>` only for a
 *   non-default `configRoot`, and carry over ` --yolo` ONLY when the original
 *   command already had it (never escalate permissions on the user's behalf).
 */
export function buildCodexResumeCommand(opts: {
  aliasName: string | null;
  configRoot: string | null;
  sessionId: string | null;
  origCmd: string;
}): string {
  const resume = opts.sessionId ? ` resume ${opts.sessionId}` : "";
  if (opts.aliasName) return `${opts.aliasName}${resume}`;
  const env =
    opts.configRoot && opts.configRoot !== DEFAULT_CODEX_ROOT
      ? `CODEX_HOME=${opts.configRoot} `
      : "";
  const yolo = opts.origCmd.includes("--yolo") ? " --yolo" : "";
  return `${env}codex${yolo}${resume}`;
}

/**
 * Build the shell line typed into the tmux pane to (re)start claude. Exports
 * CLAUDE_CONFIG_DIR when the orphan used a non-default flavor root so the resumed
 * session reads/writes the SAME history library. Resumes a known session id,
 * else starts fresh (a just-launched claude with no turn on disk yet).
 * `skipPermissions` is carried over from the original — never added by us.
 */
export function buildResumeCommand(
  bin: string,
  opts: { configRoot: string; sessionId: string | null; skipPermissions: boolean },
): string {
  const env =
    opts.configRoot && opts.configRoot !== DEFAULT_CONFIG_ROOT
      ? `CLAUDE_CONFIG_DIR=${opts.configRoot} `
      : "";
  const resume = opts.sessionId ? ` --resume ${opts.sessionId}` : "";
  const skip = opts.skipPermissions ? ` ${SKIP_PERMS}` : "";
  return `${env}${bin}${resume}${skip}`;
}
