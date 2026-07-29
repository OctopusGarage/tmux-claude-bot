import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import { SHELL_RC_FILES } from "../../shared/shell-rc.js";
import { createLogger } from "../../shared/utils/logger.js";
import { TERMINAL_MODE_RESET_SEQUENCE } from "../../shared/utils/terminal-modes.js";
import { type ProcessIntrospector, selectIntrospector } from "../platform/introspector.js";
import { createExecProbe, type ProcRow, parseEnvVar } from "./agent-config-resolver.js";
import { isClaudeProcess, matchOpenClaudeTranscript } from "./claude/claude-process.js";
import { matchOpenCodexRollout } from "./codex/codex-rollout.js";
import { matchFlavorAlias } from "./flavor-alias.js";
import type { AgentKind, AgentProfile, ReadResolver } from "./types.js";

// Re-exported so existing importers (tests, codex-takeover) are unchanged.
export { buildCodexResumeCommand, buildResumeCommand } from "./resume-command.js";

const execFileAsync = promisify(execFile);

const log = createLogger("agents.takeover");

// Claude continuously persists each completed turn to its session `.jsonl`, so a
// brief pause after a soft interrupt is enough for in-flight work to land on
// disk before we terminate and resume from it.
const SETTLE_MS = 1500;
// After typing the start command, claude takes a few seconds to spawn and render
// its TUI — so poll for liveness rather than checking once and falsely reporting
// failure while it's still booting.
const READY_POLLS = 12;
const READY_POLL_MS = 1000;
const ORPHAN_ACTIVITY_WINDOW_MS = 60_000;

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh"]);

/**
 * Whether a tmux pane's foreground command is just an idle shell — safe to type a
 * start command into. Anything else (a running claude, vim, a build…) means the
 * pane is occupied and we must not clobber it. Login shells show as `-zsh`.
 */
export function isShellForeground(cmd: string): boolean {
  return SHELLS.has(basename(cmd.trim().replace(/^-/, "")));
}

/**
 * Whether a pane is occupied by a running program. A null foreground (pane
 * couldn't be queried) is treated as NOT busy — we can't prove occupancy, and a
 * false "busy" would block every takeover; the post-resume readiness poll is the
 * backstop. A non-shell foreground (claude, an editor, a build) is busy.
 */
export function isPaneBusy(foreground: string | null): boolean {
  return foreground !== null && !isShellForeground(foreground);
}

// argv0-basename test for a claude process — shared with the config resolver via
// a leaf module (avoids a takeover ↔ agent-config-resolver import cycle).
// Re-exported here so existing importers (takeover-service, tests) are unchanged.
export { isClaudeProcess };

/**
 * PIDs running OUTSIDE every tmux pane whose command satisfies `matches` — i.e.
 * agents started directly in a terminal, out of the bot's reach. BFS-marks every
 * PID reachable from a tmux pane pid as "in tmux", then returns the matching PIDs
 * that fall outside that set.
 */
export function findOrphans(
  rows: ProcRow[],
  panePids: number[],
  matches: (command: string) => boolean,
): number[] {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const sib = children.get(r.ppid);
    if (sib) sib.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  const inTmux = new Set<number>();
  const queue = [...panePids];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (inTmux.has(pid)) continue;
    inTmux.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  const orphans: number[] = [];
  for (const r of rows) {
    if (!inTmux.has(r.pid) && matches(r.command)) orphans.push(r.pid);
  }
  return orphans;
}

export type Signal = "SIGINT" | "SIGTERM" | "SIGKILL";

/** Side-effecting OS/tmux operations, injected so the orchestration is testable. */
export interface TakeoverProbe {
  /** Process table (pid, ppid, command). */
  snapshot(): Promise<ProcRow[]>;
  /** pane_pid of every tmux pane across all sessions. Null when the tmux query
   * FAILED (vs an empty array = tmux up but no panes) — the caller bails on null
   * so a transient failure can't misclassify in-tmux claudes as adoptable. */
  tmuxPanePids(): Promise<number[] | null>;
  /** Working directory of a pid (its project root), or null. */
  cwdOf(pid: number): Promise<string | null>;
  /** The session UUID of the `.jsonl` this pid currently has open (its exact
   * session), or null when none is open right now. */
  openSessionFile(pid: number): Promise<string | null>;
  /** `ps eww` command+env line, mined for CLAUDE_CONFIG_DIR. */
  readProcEnv(pid: number): Promise<string>;
  /** Concatenated shell rc files, mined for `claude-*` launcher aliases. */
  readShellRc(): Promise<string>;
  /** Controlling terminal of the process (e.g. /dev/ttys001 or /dev/pts/0),
   * or null when the process has no terminal. */
  ttyOf(pid: number): Promise<string | null>;
  /** Best-effort reset of TUI-forced terminal modes on the given tty. */
  resetTerminal(tty: string): Promise<void>;
  /** Send a signal; swallow ESRCH (already gone). */
  signal(pid: number, sig: Signal): void;
  /** Whether the pid is still alive (kill -0). */
  isAlive(pid: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface OrphanAgent {
  pid: number;
  /** Every PID that resumes THIS session (same agent+cwd+sessionId). One agent
   * launched twice in a dir is multiple processes that all resume the same
   * session; takeover must kill them all or a survivor corrupts the resumed
   * `.jsonl`. Defaults to `[pid]` when a caller doesn't set it. */
  pids?: number[];
  cwd: string;
  /** Claude config root the orphan used — its history lives under <root>/projects. */
  configRoot: string;
  /** Newest saved session for this project, or null if none on disk yet. */
  sessionId: string | null;
  /** Resolved command to (re)start in tmux — a matched flavor alias when one was
   * inferred (carries its own env/secrets), else a reconstructed command line. */
  startCommand: string;
  /** Which agent this orphan runs. */
  agent: AgentKind;
  /** Whether this external agent appears to be executing a task. `null` means
   * unknown; outside tmux we usually cannot observe the agent TUI reliably. */
  busy?: boolean | null;
}

export type OrphanBusyState = "busy" | "idle" | "unknown";

export function orphanBusyState(o: Pick<OrphanAgent, "busy">): OrphanBusyState {
  if (o.busy === true) return "busy";
  if (o.busy === false) return "idle";
  return "unknown";
}

/** Short human label for an orphan: project dir + resumable-session hint. */
export function orphanLabel(o: OrphanAgent): string {
  const agent = o.agent === "codex" ? "Codex" : "Claude";
  const session = o.sessionId ? o.sessionId.slice(0, 8) : "new";
  return `${agent} · ${basename(o.cwd)} · ${session} · task ${orphanBusyState(o)}`;
}

/**
 * Generic orphan enumeration driven by an {@link AgentProfile}. Shared skeleton
 * for every agent: snapshot → orphan pids (profile.matchesProcess) → per-pid
 * cwd/env/open-session → config root (profile.configDirEnv + defaultConfigRoot)
 * → session id (profile.discoverSessionId) → flavor alias (profile aliases +
 * baseUrlFromEnv) → start command (profile.buildResumeCommand). The
 * agent-specific knowledge lives entirely on the profile.
 */
export async function listOrphansFor(
  probe: TakeoverProbe,
  profile: AgentProfile,
): Promise<OrphanAgent[]> {
  const rows = await probe.snapshot();
  const panePids = await probe.tmuxPanePids();
  // Can't query tmux → can't tell which agents are already in a pane. Bail
  // rather than risk listing (and later acting on) a managed in-tmux session.
  if (panePids === null) return [];
  const orphanPids = findOrphans(rows, panePids, profile.matchesProcess);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const home = homedir();
  const aliases = profile.parseFlavorAliases(await probe.readShellRc(), home);

  // Each orphan's probes are independent — run them (and the orphans) concurrently.
  const out = await Promise.all(
    orphanPids.map(async (pid): Promise<OrphanAgent | null> => {
      const [cwd, psEnv, openSession] = await Promise.all([
        probe.cwdOf(pid),
        probe.readProcEnv(pid),
        probe.openSessionFile(pid),
      ]);
      if (!cwd) return null; // can't resume without a project dir
      const configRoot = parseEnvVar(psEnv, profile.configDirEnv) ?? profile.defaultConfigRoot;
      const sessionId = await profile.discoverSessionId({ openSession, cwd, configRoot });
      const origCmd = byPid.get(pid)?.command ?? profile.kind;
      const bin = origCmd.trim().split(/\s+/)[0] ?? profile.kind;
      // Prefer the matched flavor alias — typing its NAME relaunches with the
      // flavor's full env (base url / model / key) straight from the rc file, so we
      // never read or print a secret. Fall back to a reconstructed command, carrying
      // over the original's yolo flag (if any) rather than escalating permissions.
      const aliasName = matchFlavorAlias(
        aliases,
        { configRoot, baseUrl: profile.baseUrlFromEnv(psEnv) },
        home,
      );
      const startCommand = profile.buildResumeCommand({
        aliasName,
        bin,
        configRoot,
        sessionId,
        origCmd,
      });
      const busy = await orphanBusyFromActivity(profile, configRoot, cwd, sessionId);
      return { pid, cwd, configRoot, sessionId, startCommand, agent: profile.kind, busy };
    }),
  );

  // Collapse processes that resume the SAME session (agent+cwd+sessionId) into one
  // adoptable entry — one agent launched twice in a dir shows as multiple PIDs
  // that all map to the same newest-on-disk session, so they'd render identically
  // and adopting one would leave the other writing the same `.jsonl`. Keep the
  // first as representative and carry every PID so takeover kills them all.
  const byKey = new Map<string, OrphanAgent>();
  for (const o of out.filter((o): o is OrphanAgent => o !== null)) {
    const key = `${o.agent} ${o.cwd} ${o.sessionId ?? ""}`;
    const existing = byKey.get(key);
    if (existing) existing.pids?.push(o.pid);
    else byKey.set(key, { ...o, pids: [o.pid] });
  }
  return [...byKey.values()];
}

async function orphanBusyFromActivity(
  profile: AgentProfile,
  configRoot: string,
  cwd: string,
  sessionId: string | null,
): Promise<boolean | null> {
  if (!sessionId || !profile.lastActivityAt) return null;
  const resolver: ReadResolver = {
    resolveConfigRoot: async () => configRoot,
    resolveCodexHome: async () => configRoot,
    resolveLiveTranscript: async () => null,
  };
  const last = await profile
    .lastActivityAt(resolver, `orphan:${profile.kind}`, cwd)
    .catch(() => null);
  return last === null ? null : Date.now() - last < ORPHAN_ACTIVITY_WINDOW_MS;
}

export interface TakeoverResult {
  ok: boolean;
  sessionName: string;
  resumed: boolean;
  reason?:
    | "process_would_not_die"
    | "agent_did_not_start"
    | "target_session_busy"
    | "project_agent_running"
    | "free_project_limit";
}

/** tmux/claude side-effects needed to land the adopted session, injected. */
export interface TakeoverDeps {
  probe: TakeoverProbe;
  /** Whether the project's tmux session already exists with a non-shell program
   * in the foreground (another claude, an editor…) — clobbering it is unsafe. */
  isTargetBusy(cwd: string): Promise<boolean>;
  /** Create-or-reuse the tmux session for a project dir; returns its name. */
  ensureSession(cwd: string): Promise<string>;
  /** Type a start command into the session's pane. */
  startInSession(sessionName: string, command: string): Promise<void>;
  /** Whether a claude process is now live in the session. */
  isAgentRunning(sessionName: string): Promise<boolean>;
}

/**
 * Adopt one orphan into a tmux session the bot can drive. Graceful by design:
 * SIGINT first (cancels an in-flight turn; harmless when idle — claude just arms
 * its exit prompt), settle so history flushes, re-interrupt if still busy, then
 * escalate SIGTERM→SIGKILL. Only once the original is gone do we resume the same
 * session id in tmux — two writers on one `.jsonl` would corrupt it.
 */
export async function takeover(orphan: OrphanAgent, deps: TakeoverDeps): Promise<TakeoverResult> {
  const { probe } = deps;

  // Pre-flight BEFORE touching the orphan: if the target tmux session already has
  // a program in the foreground, bail without killing the orphan — typing into it
  // would clobber that program, and we'd have nowhere to land the takeover.
  if (await deps.isTargetBusy(orphan.cwd)) {
    return { ok: false, sessionName: "", resumed: false, reason: "target_session_busy" };
  }

  // Capture the terminals that host these orphans BEFORE killing them. A TUI
  // like claude leaves the terminal in enhanced keyboard modes (kitty protocol,
  // modifyOtherKeys, focus tracking, bracketed paste). An abrupt signal-kill
  // never gives it a chance to reset, so the user's shell afterwards prints raw
  // CSI sequences for every keystroke. We remember the ttys here and reset them
  // once the processes are confirmed dead.
  const orphanTtys = new Set<string>();
  for (const pid of orphan.pids ?? [orphan.pid]) {
    const tty = await probe.ttyOf(pid);
    if (tty) orphanTtys.add(tty);
  }

  // Kill every process resuming this session — a survivor would corrupt the
  // resumed `.jsonl` (two writers on one file). SIGINT first: cancels an in-flight
  // generation (and flushes that turn to disk), harmless when idle; settle, then
  // escalate SIGTERM→SIGKILL.
  const killPid = async (pid: number): Promise<boolean> => {
    probe.signal(pid, "SIGINT");
    await probe.sleep(SETTLE_MS);
    if (await probe.isAlive(pid)) {
      probe.signal(pid, "SIGTERM");
      await probe.sleep(SETTLE_MS);
    }
    if (await probe.isAlive(pid)) {
      probe.signal(pid, "SIGKILL");
      await probe.sleep(500);
    }
    return !(await probe.isAlive(pid));
  };
  for (const pid of orphan.pids ?? [orphan.pid]) {
    if (!(await killPid(pid))) {
      log.warn(`pid=${pid} would not die`);
      return { ok: false, sessionName: "", resumed: false, reason: "process_would_not_die" };
    }
  }

  // Reset any terminals the orphans had attached. This is best-effort: the tty
  // may already be closed or reassigned by the time we get here.
  for (const tty of orphanTtys) {
    await probe.resetTerminal(tty);
  }

  const sessionName = await deps.ensureSession(orphan.cwd);
  await deps.startInSession(sessionName, orphan.startCommand);

  // Poll — claude is up once a claude process appears in the pane, which lags the
  // typed command by a few seconds.
  let running = false;
  for (let i = 0; i < READY_POLLS; i++) {
    if (await deps.isAgentRunning(sessionName)) {
      running = true;
      break;
    }
    await probe.sleep(READY_POLL_MS);
  }
  log.info(
    `pid=${orphan.pid} -> session=${sessionName} resumed=${orphan.sessionId !== null} ok=${running}`,
  );
  const result: TakeoverResult = {
    ok: running,
    sessionName,
    resumed: orphan.sessionId !== null,
  };
  if (!running) result.reason = "agent_did_not_start";
  return result;
}

/** Real probe: introspector for the process table / open files / cwd, plus tmux
 * pane enumeration, signals, and shell-rc reading. */
export function createTakeoverProbe(
  intro: ProcessIntrospector = selectIntrospector(),
): TakeoverProbe {
  const base = createExecProbe(intro);
  return {
    snapshot: () => base.snapshot(),
    readProcEnv: (pid) => base.readProcEnv(pid),
    isAlive: (pid) => base.isAlive(pid),
    async readShellRc(): Promise<string> {
      const home = homedir();
      const parts = await Promise.all(
        SHELL_RC_FILES.map((f) => readFile(`${home}/${f}`, "utf8").catch(() => "")),
      );
      return parts.join("\n");
    },
    async tmuxPanePids(): Promise<number[] | null> {
      try {
        const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{pane_pid}"], {
          timeout: 5000,
        });
        return stdout
          .split("\n")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => !Number.isNaN(n));
      } catch {
        return null; // query failed — distinct from "no panes" ([])
      }
    },
    async openSessionFile(pid: number): Promise<string | null> {
      // The transcript this pid holds open — claude's projects/<dir>/<uuid>.jsonl
      // OR codex's rollout-<uuid>.jsonl, so an orphan takeover resumes the EXACT
      // session even under same-cwd contention (was claude-only → codex always fell
      // back to the newest-on-disk rollout, which can be a different session).
      const files = await intro.listOpenFiles(pid);
      return (matchOpenClaudeTranscript(files) ?? matchOpenCodexRollout(files))?.sessionId ?? null;
    },
    cwdOf: (pid) => intro.cwdOf(pid),
    ttyOf: (pid) => intro.ttyOf(pid),
    async resetTerminal(tty: string): Promise<void> {
      try {
        await writeFile(tty, TERMINAL_MODE_RESET_SEQUENCE);
      } catch {
        // Best-effort: the tty may have closed or permissions may have changed.
      }
    },
    signal(pid: number, sig: Signal): void {
      try {
        process.kill(pid, sig);
      } catch {
        // ESRCH — already gone; nothing to do.
      }
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}
