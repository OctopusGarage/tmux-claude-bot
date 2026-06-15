import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../shared/utils/logger.js";

export type { ProcRow } from "./platform/introspector.js";

import type { ProcRow } from "./platform/introspector.js";
import { type ProcessIntrospector, selectIntrospector } from "./platform/introspector.js";

const execFileAsync = promisify(execFile);

/**
 * Extract an env var value from `ps eww -o command= -p <pid>` output (the env is
 * appended to the command line as space-separated KEY=VALUE tokens on macOS,
 * where /proc/<pid>/environ does not exist).
 */
export function parseEnvVar(psEwwOutput: string, key: string): string | null {
  const m = psEwwOutput.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`));
  return m?.[1] ?? null;
}

export function parseClaudeConfigDir(psEwwOutput: string): string | null {
  return parseEnvVar(psEwwOutput, "CLAUDE_CONFIG_DIR");
}

/** What endpoint/auth a running claude is using, mined from its process env.
 * `baseUrl` is null when ANTHROPIC_BASE_URL is unset (= default api.anthropic.com).
 * `mode` is "api" when an API key/token is set, else "subscription" (claude.ai
 * OAuth login). NEVER carries the key itself — only its presence. */
export interface ClaudeApiInfo {
  baseUrl: string | null;
  mode: "api" | "subscription";
}

/** Derive {@link ClaudeApiInfo} from a process env blob (ps eww / /proc environ). */
export function parseApiInfo(envBlob: string): ClaudeApiInfo {
  const baseUrl = parseEnvVar(envBlob, "ANTHROPIC_BASE_URL");
  const hasKey =
    parseEnvVar(envBlob, "ANTHROPIC_API_KEY") !== null ||
    parseEnvVar(envBlob, "ANTHROPIC_AUTH_TOKEN") !== null;
  return { baseUrl, mode: hasKey ? "api" : "subscription" };
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/**
 * Whether a command line is a claude process. Matches by the EXECUTABLE name
 * (argv[0]'s basename), so both the bot's full-path invocation
 * (`/Users/x/.local/bin/claude …`) and a bare alias invocation
 * (`claude …`, e.g. claude-stella) are recognized — while an unrelated command
 * that merely mentions "claude" in an argument is not.
 */
function isClaudeCommand(command: string, claudeName: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  const name = basename(argv0);
  // Flavored launchers (claude-stella, claude-yolo, …) are aliases/wrappers that
  // exec the real `claude` binary, so the running process's argv0 is `claude`
  // (or a `claude-<flavor>` wrapper) — NOT the configured launcher name. Match
  // the generic claude binary as well as the exact configured name, mirroring
  // isClaudeProcess in takeover.ts (only argv0 counts — never an argument).
  return name === claudeName || name === "claude" || name.startsWith("claude-");
}

/**
 * Find the running claude process under a tmux pane. Walks the process tree from
 * the pane pid and returns the first process whose executable is claude.
 */
export function findClaudePid(rows: ProcRow[], panePid: number, claudeBin: string): number | null {
  const claudeName = basename(claudeBin);
  const children = new Map<number, number[]>();
  const command = new Map<number, string>();
  for (const r of rows) {
    command.set(r.pid, r.command);
    const siblings = children.get(r.ppid);
    if (siblings) siblings.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const queue: number[] = [panePid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const cmd = command.get(pid);
    if (cmd && isClaudeCommand(cmd, claudeName)) return pid;
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return null;
}

export interface ResolverProbe {
  /** pane_pid of the session's pane, or null if it can't be determined. */
  panePid(session: string): Promise<number | null>;
  /** A snapshot of the process table (pid, ppid, command). */
  snapshot(): Promise<ProcRow[]>;
  /** `ps eww -o command= -p <pid>` output (command line + env). */
  readProcEnv(pid: number): Promise<string>;
  /** Whether a pid is still alive (kill -0). */
  isAlive(pid: number): Promise<boolean>;
  now(): number;
}

export interface ConfigResolver {
  /** Resolve the Claude config root (history lives under <root>/projects/…). */
  resolveConfigRoot(session: string): Promise<string>;
  /** Whether a claude process is running in the session's pane (process-based). */
  isClaudeRunning(session: string): Promise<boolean>;
  /** Endpoint/auth mode of the running claude, or null when none is running.
   * Optional so existing fakes need not implement it. */
  resolveApiInfo?(session: string): Promise<ClaudeApiInfo | null>;
  /** Drop the cached entry — call on lifecycle changes (/clear, /compact, switch…). */
  invalidate(session: string): void;
}

interface CacheEntry {
  claudePid: number;
  configRoot: string;
  checkedAt: number;
}

/**
 * Per-session resolver for the active claude's config dir, cached in memory.
 * Cheap path: if the cached claude pid is still alive and within TTL, return the
 * cached root without touching tmux/ps. Expensive path (cache miss / pid dead /
 * TTL expired / explicit invalidation): walk the pane's process tree, find the
 * claude pid, read its CLAUDE_CONFIG_DIR via `ps eww`, and cache it.
 */
export function createConfigResolver(
  probe: ResolverProbe,
  opts: { defaultRoot: string; claudeBin: string; ttlMs: number },
): ConfigResolver {
  const cache = new Map<string, CacheEntry>();

  // Single source of truth for "find the claude process in a pane". Returns
  // null when the pane can't be queried; { claudePid: null } when the pane is
  // there but no claude runs in it. Shared by resolveConfigRoot and isClaudeRunning.
  const scanPane = async (
    session: string,
  ): Promise<{ panePid: number; claudePid: number | null } | null> => {
    const panePid = await probe.panePid(session);
    if (panePid === null) return null;
    return { panePid, claudePid: findClaudePid(await probe.snapshot(), panePid, opts.claudeBin) };
  };

  // Cheap liveness check: a cached pid that's still alive within the TTL.
  const cachedPidAlive = async (session: string): Promise<boolean> => {
    const cached = cache.get(session);
    return (
      cached !== undefined &&
      probe.now() - cached.checkedAt < opts.ttlMs &&
      (await probe.isAlive(cached.claudePid))
    );
  };

  return {
    async resolveConfigRoot(session: string): Promise<string> {
      if (await cachedPidAlive(session)) {
        return (cache.get(session) as CacheEntry).configRoot; // cheap path
      }
      const scan = await scanPane(session);
      if (scan === null) {
        // Can't query the pane — keep the last known root if we have one.
        return cache.get(session)?.configRoot ?? opts.defaultRoot;
      }
      if (scan.claudePid === null) {
        cache.delete(session); // claude not running in this pane
        return opts.defaultRoot;
      }
      const configRoot =
        parseClaudeConfigDir(await probe.readProcEnv(scan.claudePid)) ?? opts.defaultRoot;
      cache.set(session, { claudePid: scan.claudePid, configRoot, checkedAt: probe.now() });
      logger.info(
        `[config-resolver] session=${session} claudePid=${scan.claudePid} root=${configRoot}`,
      );
      return configRoot;
    },

    async isClaudeRunning(session: string): Promise<boolean> {
      if (await cachedPidAlive(session)) return true; // cheap path
      const scan = await scanPane(session);
      return scan?.claudePid != null;
    },

    async resolveApiInfo(session: string): Promise<ClaudeApiInfo | null> {
      const pid = (await cachedPidAlive(session))
        ? (cache.get(session) as CacheEntry).claudePid
        : ((await scanPane(session))?.claudePid ?? null);
      if (pid === null) return null;
      return parseApiInfo(await probe.readProcEnv(pid));
    },

    invalidate(session: string): void {
      cache.delete(session);
    },
  };
}

/** Real probe: tmux for pane pid, an OS introspector for the process table,
 * process.kill for liveness. */
export function createExecProbe(intro: ProcessIntrospector = selectIntrospector()): ResolverProbe {
  return {
    async panePid(session: string): Promise<number | null> {
      try {
        const { stdout } = await execFileAsync(
          "tmux",
          ["list-panes", "-t", session, "-F", "#{pane_pid}"],
          { timeout: 5000 },
        );
        const pid = Number.parseInt(stdout.split("\n")[0]?.trim() ?? "", 10);
        return Number.isNaN(pid) ? null : pid;
      } catch {
        return null;
      }
    },
    snapshot: () => intro.snapshot(),
    readProcEnv: (pid) => intro.readProcEnv(pid),
    async isAlive(pid: number): Promise<boolean> {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    now: () => Date.now(),
  };
}
