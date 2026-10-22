import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentApiInfo, AgentKind } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { isClaudeProcess, matchOpenClaudeTranscript } from "./claude/claude-process.js";
import { isCodexProcess } from "./codex/codex-process.js";
import { matchNewestOpenCodexRollout } from "./codex/codex-rollout.js";
import { getLastLiveSessionId, recordLiveSessionId } from "./live-session-id.js";

export type { ProcRow } from "../platform/introspector.js";

import type { ProcRow } from "../platform/introspector.js";
import { type ProcessIntrospector, selectIntrospector } from "../platform/introspector.js";

const execFileAsync = promisify(execFile);

const log = createLogger("agents.config-resolver");

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

/** Derive an {@link AgentApiInfo} for claude from a process env blob (ps eww /
 * /proc environ): `baseUrl` from ANTHROPIC_BASE_URL (null = api.anthropic.com),
 * `mode` "api" when an API key/token is set else "subscription" (claude.ai OAuth).
 * NEVER carries the key itself — only its presence. */
export function parseApiInfo(envBlob: string): AgentApiInfo {
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
  // `claudeName` is the configured launcher basename — an escape hatch for a
  // custom-named binary. Otherwise fall back to the shared generic test, since
  // flavored launchers (claude-stella, claude-yolo, …) are aliases that exec the
  // real `claude` binary, so the running process's argv0 is `claude` (or a
  // `claude-<flavor>` wrapper), NOT the configured launcher name.
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  return basename(argv0) === claudeName || isClaudeProcess(command);
}

/**
 * Walk the pane's process tree and return the first pid whose command satisfies
 * `matches`. Used by both claude and codex detection.
 */
export function findAgentPid(
  rows: ProcRow[],
  panePid: number,
  matches: (command: string) => boolean,
): number | null {
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
    if (cmd && matches(cmd)) return pid;
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
  /** Absolute paths of files the process currently has open. */
  listOpenFiles(pid: number): Promise<string[]>;
  /** Whether a pid is still alive (kill -0). */
  isAlive(pid: number): Promise<boolean>;
  now(): number;
}

/** The transcript JSONL a live agent pid holds open (path + its session/rollout
 * id), for BOTH claude and codex. The exact live session under same-cwd (Free
 * Projects) contention, where the newest-on-disk guess can pick the wrong one. */
export interface LiveTranscript {
  path: string;
  sessionId: string | null;
}

export interface ConfigResolver {
  /** Resolve the Claude config root (history lives under <root>/projects/…). */
  resolveConfigRoot(session: string): Promise<string>;
  /** Whether a claude process is running in the session's pane (process-based). */
  isClaudeRunning(session: string): Promise<boolean>;
  /** Whether a codex process is running in the session's pane (process-based). */
  isCodexRunning(session: string): Promise<boolean>;
  /** Endpoint/auth mode of the running claude, or null when none is running.
   * Optional so existing fakes need not implement it. */
  resolveApiInfo?(session: string): Promise<AgentApiInfo | null>;
  /** Resolve CODEX_HOME of the running codex in the session's pane, or null when
   * none is running / it is unset (codex then uses its default ~/.codex).
   * Optional so existing fakes need not implement it. */
  resolveCodexHome?(session: string): Promise<string | null>;
  /** The transcript the LIVE agent (claude or codex) in the session's pane holds
   * open — exact under same-cwd contention where the newest-on-disk guess can pick
   * the wrong session. Null when neither runs / nothing is open. Optional so
   * existing fakes need not implement it. */
  resolveLiveTranscript?(session: string): Promise<LiveTranscript | null>;
  /** Which agent is LIVE in the session's pane, by inspecting the running
   * process — "codex"/"claude", or null when neither is running yet.
   * Optional so existing fakes need not implement it. */
  detectAgentKind?(session: string): Promise<AgentKind | null>;
  /** The last session id this session's live transcript was observed to be —
   * a persisted, self-healing fallback for /restart when the live id can't be
   * read right now. Optional so existing fakes need not implement it. */
  lastLiveSessionId?(session: string): string | null;
  /** Drop the cached entry — call on lifecycle changes (/clear, /compact, switch…). */
  invalidate(session: string): void;
}

interface CacheEntry {
  /** The live agent process pid detected in the pane. */
  agentPid: number;
  kind: AgentKind;
  /** Resolved config home: claude CLAUDE_CONFIG_DIR (or default), codex CODEX_HOME
   * (null when unset). */
  home: string | null;
  /** The transcript this pid holds open, resolved lazily and cached (the open file
   * is stable for a session; invalidate() clears it on /clear//compact/switch).
   * `undefined` = not yet resolved. */
  transcript?: LiveTranscript | null;
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

  // Coalesce process-table dumps. snapshot() reads the WHOLE OS process table;
  // a single /list_alive_projects render resolves many sessions concurrently, and
  // each (detectAgentKind, isCodexRunning, resolveCodexHome, resolveLiveTranscript,
  // scanPane) would otherwise re-dump it. We cache the in-flight Promise for a
  // short window so one render shares one dump. The window is tiny so detection
  // stays effectively live; a failed dump is never cached.
  const SNAPSHOT_TTL_MS = 250;
  let snap: { at: number; rows: Promise<ProcRow[]> } | null = null;
  const snapshot = (): Promise<ProcRow[]> => {
    const now = probe.now();
    if (snap && now - snap.at < SNAPSHOT_TTL_MS) return snap.rows;
    const rows = probe.snapshot();
    snap = { at: now, rows };
    rows.catch(() => {
      if (snap?.rows === rows) snap = null; // don't pin a rejected dump
    });
    return rows;
  };

  // Same coalescing for the per-session pane-pid lookup (one `tmux list-panes`
  // subprocess each). detectAgentKind / isCodexRunning / resolveCodexHome /
  // resolveLiveTranscript / scanPane all ask for the SAME session's pane pid
  // back-to-back on the reply + alive-list paths — share one lookup per window.
  const panePidCache = new Map<string, { at: number; pid: Promise<number | null> }>();
  const panePidOf = (session: string): Promise<number | null> => {
    const now = probe.now();
    const c = panePidCache.get(session);
    if (c && now - c.at < SNAPSHOT_TTL_MS) return c.pid;
    const pid = probe.panePid(session);
    panePidCache.set(session, { at: now, pid });
    pid.catch(() => {
      if (panePidCache.get(session)?.pid === pid) panePidCache.delete(session);
    });
    return pid;
  };

  // The configurable launcher basename is honored for claude (escape hatch for a
  // custom-named binary); a flavored `claude-*` wrapper falls back to the generic
  // claude test. Codex is matched generically. One matcher for BOTH agents.
  const claudeName = basename(opts.claudeBin);
  const matchAgent = (cmd: string): boolean =>
    isClaudeCommand(cmd, claudeName) || isCodexProcess(cmd);

  // SINGLE source of truth: detect the live agent in the pane (claude or codex),
  // resolve its config home, and cache {pid, kind, home} per session — shared by
  // every public method below. Cheap path: a cached agent pid still alive within
  // the TTL returns the cached entry with NO ps/tmux/readProcEnv. `paneQueryable`
  // distinguishes "pane gone" (keep last known) from "no agent in pane".
  const resolveAgent = async (
    session: string,
  ): Promise<{ entry: CacheEntry | null; paneQueryable: boolean }> => {
    const cached = cache.get(session);
    if (
      cached !== undefined &&
      probe.now() - cached.checkedAt < opts.ttlMs &&
      (await probe.isAlive(cached.agentPid))
    ) {
      return { entry: cached, paneQueryable: true }; // cheap path
    }
    const panePid = await panePidOf(session);
    if (panePid === null) return { entry: null, paneQueryable: false };
    const rows = await snapshot();
    const pid = findAgentPid(rows, panePid, matchAgent);
    if (pid === null) {
      cache.delete(session); // no agent runs in this pane
      return { entry: null, paneQueryable: true };
    }
    const command = rows.find((r) => r.pid === pid)?.command ?? "";
    const kind: AgentKind = isCodexProcess(command) ? "codex" : "claude";
    const home =
      kind === "codex"
        ? parseEnvVar(await probe.readProcEnv(pid), "CODEX_HOME")
        : (parseClaudeConfigDir(await probe.readProcEnv(pid)) ?? opts.defaultRoot);
    const entry: CacheEntry = { agentPid: pid, kind, home, checkedAt: probe.now() };
    cache.set(session, entry);
    log.debug("agent runtime resolved", {
      session,
      data: { kind, pid, home },
    });
    return { entry, paneQueryable: true };
  };

  return {
    async resolveConfigRoot(session: string): Promise<string> {
      const { entry, paneQueryable } = await resolveAgent(session);
      if (entry?.kind === "claude") return entry.home ?? opts.defaultRoot;
      // Pane unqueryable → keep the last known claude root; else the default.
      if (!paneQueryable) {
        const last = cache.get(session);
        return last?.kind === "claude" ? (last.home ?? opts.defaultRoot) : opts.defaultRoot;
      }
      return opts.defaultRoot;
    },

    async isClaudeRunning(session: string): Promise<boolean> {
      return (await resolveAgent(session)).entry?.kind === "claude";
    },

    async isCodexRunning(session: string): Promise<boolean> {
      return (await resolveAgent(session)).entry?.kind === "codex";
    },

    async resolveApiInfo(session: string): Promise<AgentApiInfo | null> {
      const { entry } = await resolveAgent(session);
      if (entry?.kind !== "claude") return null;
      return parseApiInfo(await probe.readProcEnv(entry.agentPid));
    },

    async detectAgentKind(session: string): Promise<AgentKind | null> {
      return (await resolveAgent(session)).entry?.kind ?? null;
    },

    lastLiveSessionId(session: string): string | null {
      return getLastLiveSessionId(session);
    },

    async resolveCodexHome(session: string): Promise<string | null> {
      const { entry } = await resolveAgent(session);
      return entry?.kind === "codex" ? entry.home : null;
    },

    async resolveLiveTranscript(session: string): Promise<LiveTranscript | null> {
      const { entry } = await resolveAgent(session);
      if (!entry) return null;
      if (entry.transcript === undefined) {
        // Whichever transcript the live pid holds open — claude's
        // projects/<dir>/<uuid>.jsonl or codex's sessions/.../rollout-<uuid>.jsonl.
        const files = await probe.listOpenFiles(entry.agentPid);
        entry.transcript =
          matchOpenClaudeTranscript(files) ?? (await matchNewestOpenCodexRollout(files));
      }
      // Refresh the persisted last-observed id (self-healing) so /restart can
      // disambiguate co-located Free-Project sessions when the live id later
      // can't be read. No-op when unchanged.
      if (entry.transcript?.sessionId) recordLiveSessionId(session, entry.transcript.sessionId);
      return entry.transcript;
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
    listOpenFiles: (pid) => intro.listOpenFiles(pid),
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
