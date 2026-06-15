import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import { logger } from "../shared/utils/logger.js";
import {
  createExecProbe,
  type ProcRow,
  parseClaudeConfigDir,
  parseEnvVar,
} from "./claude-config-resolver.js";
import { matchFlavorAlias, parseFlavorAliases } from "./flavor-alias.js";
import { DEFAULT_CONFIG_ROOT, listClaudeSessions } from "./history.js";
import { type ProcessIntrospector, selectIntrospector } from "./platform/introspector.js";

const execFileAsync = promisify(execFile);

// Claude continuously persists each completed turn to its session `.jsonl`, so a
// brief pause after a soft interrupt is enough for in-flight work to land on
// disk before we terminate and resume from it.
const SETTLE_MS = 1500;
// After typing the start command, claude takes a few seconds to spawn and render
// its TUI — so poll for liveness rather than checking once and falsely reporting
// failure while it's still booting.
const READY_POLLS = 12;
const READY_POLL_MS = 1000;
// YOLO mode (skips every edit/command confirmation). We never ADD this on the
// user's behalf — we only carry it over when the original process already had it,
// so a takeover can't silently escalate a cautious session's permissions.
const SKIP_PERMS = "--dangerously-skip-permissions";

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

/**
 * argv0-basename test for a claude process. Every flavor (claude-stella,
 * claude-ollama, …) runs the SAME `claude` binary and only differs by env
 * (CLAUDE_CONFIG_DIR), so at runtime argv0 is `claude` or an absolute path
 * ending in `/claude`. A bare wrapper script named `claude-<flavor>` is matched
 * too. An unrelated command that merely mentions claude in an argument
 * (`vim claude.ts`, `node build-claude.js`) is not — only argv0 counts.
 */
export function isClaudeProcess(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  const name = basename(argv0);
  return name === "claude" || name.startsWith("claude-");
}

/**
 * Claude PIDs running OUTSIDE every tmux pane — i.e. started directly in a
 * terminal, out of the bot's reach. BFS-marks every PID reachable from a tmux
 * pane pid as "in tmux", then returns the claude PIDs that fall outside that set.
 */
export function findOrphanClaudes(rows: ProcRow[], panePids: number[]): number[] {
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
    if (!inTmux.has(r.pid) && isClaudeProcess(r.command)) orphans.push(r.pid);
  }
  return orphans;
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
  /** Send a signal; swallow ESRCH (already gone). */
  signal(pid: number, sig: Signal): void;
  /** Whether the pid is still alive (kill -0). */
  isAlive(pid: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface OrphanClaude {
  pid: number;
  cwd: string;
  /** Claude config root the orphan used — its history lives under <root>/projects. */
  configRoot: string;
  /** Newest saved session for this project, or null if none on disk yet. */
  sessionId: string | null;
  /** Resolved command to (re)start in tmux — a matched flavor alias when one was
   * inferred (carries its own env/secrets), else a reconstructed command line. */
  startCommand: string;
}

/** Short human label for an orphan: project dir + resumable-session hint. */
export function orphanLabel(o: OrphanClaude): string {
  return `${basename(o.cwd)}${o.sessionId ? ` · ${o.sessionId.slice(0, 8)}` : " · new"}`;
}

/** Enumerate non-tmux claude processes the bot could adopt, newest session each. */
export async function listOrphans(probe: TakeoverProbe): Promise<OrphanClaude[]> {
  const rows = await probe.snapshot();
  const panePids = await probe.tmuxPanePids();
  // Can't query tmux → can't tell which claudes are already in a pane. Bail
  // rather than risk listing (and later acting on) a managed in-tmux session.
  if (panePids === null) return [];
  const orphanPids = findOrphanClaudes(rows, panePids);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const home = homedir();
  const aliases = parseFlavorAliases(await probe.readShellRc(), home);

  // Each orphan's probes are independent — run them (and the orphans) concurrently.
  const out = await Promise.all(
    orphanPids.map(async (pid): Promise<OrphanClaude | null> => {
      const [cwd, psEnv, openSession] = await Promise.all([
        probe.cwdOf(pid),
        probe.readProcEnv(pid),
        probe.openSessionFile(pid),
      ]);
      if (!cwd) return null; // can't resume without a project dir
      const configRoot = parseClaudeConfigDir(psEnv) ?? DEFAULT_CONFIG_ROOT;
      // Prefer the session this PID actually has open (exact); fall back to the
      // newest on disk when it isn't holding the file open between turns.
      const sessionId =
        openSession ?? (await listClaudeSessions(cwd, configRoot, 1))[0]?.sessionId ?? null;
      const origCmd = byPid.get(pid)?.command ?? "claude";
      const bin = origCmd.trim().split(/\s+/)[0] ?? "claude";
      // Prefer the matched flavor alias — typing its NAME relaunches with the
      // flavor's full env (base url / model / key) straight from the rc file, so we
      // never read or print a secret. Fall back to a reconstructed command, carrying
      // over the original's yolo flag (if any) rather than escalating permissions.
      const aliasName = matchFlavorAlias(
        aliases,
        { configRoot, baseUrl: parseEnvVar(psEnv, "ANTHROPIC_BASE_URL") },
        home,
      );
      const startCommand = aliasName
        ? `${aliasName}${sessionId ? ` --resume ${sessionId}` : ""}`
        : buildResumeCommand(bin, {
            configRoot,
            sessionId,
            skipPermissions: origCmd.includes(SKIP_PERMS),
          });
      return { pid, cwd, configRoot, sessionId, startCommand };
    }),
  );
  return out.filter((o): o is OrphanClaude => o !== null);
}

export interface TakeoverResult {
  ok: boolean;
  sessionName: string;
  resumed: boolean;
  reason?: "process_would_not_die" | "claude_did_not_start" | "target_session_busy";
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
  isClaudeRunning(sessionName: string): Promise<boolean>;
}

/**
 * Adopt one orphan into a tmux session the bot can drive. Graceful by design:
 * SIGINT first (cancels an in-flight turn; harmless when idle — claude just arms
 * its exit prompt), settle so history flushes, re-interrupt if still busy, then
 * escalate SIGTERM→SIGKILL. Only once the original is gone do we resume the same
 * session id in tmux — two writers on one `.jsonl` would corrupt it.
 */
export async function takeover(orphan: OrphanClaude, deps: TakeoverDeps): Promise<TakeoverResult> {
  const { probe } = deps;

  // Pre-flight BEFORE touching the orphan: if the target tmux session already has
  // a program in the foreground, bail without killing the orphan — typing into it
  // would clobber that program, and we'd have nowhere to land the takeover.
  if (await deps.isTargetBusy(orphan.cwd)) {
    return { ok: false, sessionName: "", resumed: false, reason: "target_session_busy" };
  }

  // SIGINT first: cancels an in-flight generation (and flushes that turn to disk),
  // harmless when idle. Settle, then escalate.
  probe.signal(orphan.pid, "SIGINT");
  await probe.sleep(SETTLE_MS);

  if (await probe.isAlive(orphan.pid)) {
    probe.signal(orphan.pid, "SIGTERM");
    await probe.sleep(SETTLE_MS);
  }
  if (await probe.isAlive(orphan.pid)) {
    probe.signal(orphan.pid, "SIGKILL");
    await probe.sleep(500);
  }
  if (await probe.isAlive(orphan.pid)) {
    logger.warn(`[takeover] pid=${orphan.pid} would not die`);
    return { ok: false, sessionName: "", resumed: false, reason: "process_would_not_die" };
  }

  const sessionName = await deps.ensureSession(orphan.cwd);
  await deps.startInSession(sessionName, orphan.startCommand);

  // Poll — claude is up once a claude process appears in the pane, which lags the
  // typed command by a few seconds.
  let running = false;
  for (let i = 0; i < READY_POLLS; i++) {
    if (await deps.isClaudeRunning(sessionName)) {
      running = true;
      break;
    }
    await probe.sleep(READY_POLL_MS);
  }
  logger.info(
    `[takeover] pid=${orphan.pid} -> session=${sessionName} resumed=${orphan.sessionId !== null} ok=${running}`,
  );
  const result: TakeoverResult = {
    ok: running,
    sessionName,
    resumed: orphan.sessionId !== null,
  };
  if (!running) result.reason = "claude_did_not_start";
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
      const files = [".zshrc", ".bashrc", ".zprofile", ".bash_profile", ".aliases", ".zsh_aliases"];
      const parts = await Promise.all(
        files.map((f) => readFile(`${home}/${f}`, "utf8").catch(() => "")),
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
      const files = await intro.listOpenFiles(pid);
      for (const f of files) {
        const m = f.match(
          /\/projects\/[^/\n]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/,
        );
        if (m?.[1]) return m[1];
      }
      return null;
    },
    cwdOf: (pid) => intro.cwdOf(pid),
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
