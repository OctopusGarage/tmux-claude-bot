import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink as defaultUnlinkFile, writeFile as defaultWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sleep as defaultSleep } from "../../shared/utils/sleep.js";
import { TERMINAL_MODE_RESET_SEQUENCE } from "../../shared/utils/terminal-modes.js";

export type ExecResult = {
  stdout: string;
  stderr: string;
};

export type ExecFileOptions = { timeout?: number };
export type ExecFileLike = (
  file: string,
  args: string[],
  options?: ExecFileOptions,
) => Promise<ExecResult>;
export type WriteFileLike = (file: string, data: string) => Promise<void>;
export type UnlinkFileLike = (file: string) => Promise<void>;

const execFileAsync = promisify(execFile);
const DEFAULT_SUBMIT_SETTLE_MS = 50;
let sendBufferCounter = 0;

function defaultExecFile(file: string, args: string[], options?: { timeout?: number }) {
  return execFileAsync(file, args, { timeout: options?.timeout });
}

function isSafeClientTty(path: string): boolean {
  return /^\/dev\/[A-Za-z0-9._/-]+$/.test(path);
}

function nextSendBufferName(): string {
  sendBufferCounter += 1;
  return `tcb-send-${process.pid}-${Date.now()}-${sendBufferCounter}`;
}

function sendBufferFilePath(bufferName: string): string {
  return join(tmpdir(), `${bufferName}-${randomUUID()}.txt`);
}

function isMissingSessionKillError(err: unknown, sessionName: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(`can't find session: ${sessionName}`) && message.includes("kill-session");
}

export class TmuxBridge {
  private readonly execFile: ExecFileLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly writeFile: WriteFileLike;
  private readonly unlinkFile: UnlinkFileLike;
  private getSessionName: () => Promise<string>;
  private readonly window: number;
  private readonly pane: number;
  private readonly projectSessionPrefix: string;
  private readonly submitSettleMs: number;

  constructor(options: {
    execFile?: ExecFileLike;
    sleep?: (ms: number) => Promise<void>;
    writeFile?: WriteFileLike;
    unlinkFile?: UnlinkFileLike;
    getSessionName: () => Promise<string>;
    window?: number;
    pane?: number;
    projectSessionPrefix?: string;
    submitSettleMs?: number;
  }) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.sleep = options.sleep ?? defaultSleep;
    this.writeFile = options.writeFile ?? defaultWriteFile;
    this.unlinkFile = options.unlinkFile ?? defaultUnlinkFile;
    this.getSessionName = options.getSessionName;
    this.window = options.window ?? 0;
    this.pane = options.pane ?? 0;
    this.projectSessionPrefix = options.projectSessionPrefix ?? "tmux_proj_";
    this.submitSettleMs = options.submitSettleMs ?? DEFAULT_SUBMIT_SETTLE_MS;
  }

  private async formatTarget(sessionName?: string): Promise<string> {
    const session = sessionName ?? (await this.getSessionName());
    return `${session}:${this.window}.${this.pane}`;
  }

  /** Resolve an explicit session name, or the configured default when omitted. */
  resolveSessionName(sessionName?: string): Promise<string> {
    return sessionName !== undefined ? Promise.resolve(sessionName) : this.getSessionName();
  }

  private async cancelCopyMode(target: string): Promise<void> {
    try {
      await this.execFile("tmux", ["send-keys", "-t", target, "-X", "cancel"], { timeout: 10000 });
    } catch {
      // tmux returns "not in a mode" when the pane is already accepting keys.
    }
  }

  async isPaneAlive(sessionName?: string): Promise<boolean> {
    try {
      const target = await this.formatTarget(sessionName);
      const result = await this.execFile("tmux", ["list-panes", "-t", target, "-F", "#{pane_id}"], {
        timeout: 10000,
      });
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Paste `text` as one prompt, then submit once.
   *
   * Text goes through a tmux buffer so embedded newlines remain prompt content
   * instead of being interpreted as Enter. The final `C-m` is the single submit.
   * For named keys or raw Enter use `sendRawKey`.
   */
  async sendKeys(text: string, sessionName?: string): Promise<void> {
    const target = await this.formatTarget(sessionName);
    await this.cancelCopyMode(target);
    const bufferName = nextSendBufferName();
    const bufferFile = sendBufferFilePath(bufferName);
    try {
      await this.writeFile(bufferFile, text);
      await this.execFile("tmux", ["load-buffer", "-b", bufferName, bufferFile], {
        timeout: 10000,
      });
      await this.execFile("tmux", ["paste-buffer", "-p", "-b", bufferName, "-t", target], {
        timeout: 10000,
      });
      if (this.submitSettleMs > 0) await this.sleep(this.submitSettleMs);
      await this.execFile("tmux", ["send-keys", "-t", target, "C-m"], { timeout: 10000 });
    } finally {
      try {
        await this.execFile("tmux", ["delete-buffer", "-b", bufferName], { timeout: 10000 });
      } catch {
        // Best-effort cleanup; a send failure should surface as the original error.
      }
      try {
        await this.unlinkFile(bufferFile);
      } catch {
        // Best-effort cleanup; a send failure should surface as the original error.
      }
    }
  }

  async sendRawKey(key: string, sessionName?: string): Promise<void> {
    const target = await this.formatTarget(sessionName);
    await this.cancelCopyMode(target);
    await this.execFile("tmux", ["send-keys", "-t", target, key], { timeout: 10000 });
  }

  /** The command running in the foreground of the session's pane (tmux
   * `pane_current_command`), e.g. `zsh` for an idle prompt or `claude`/`vim` when
   * a program is running. Null if the session/pane can't be queried. */
  async paneCurrentCommand(sessionName?: string): Promise<string | null> {
    const target = await this.formatTarget(sessionName);
    try {
      const result = await this.execFile(
        "tmux",
        ["display-message", "-p", "-t", target, "#{pane_current_command}"],
        { timeout: 5000 },
      );
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** The pane's current working directory (tmux `pane_current_path`) — where the
   * shell/agent actually is now, which can drift from the dir the session was
   * bound to (a typed `cd`). Null if the session/pane can't be queried or empty. */
  async paneCurrentPath(sessionName?: string): Promise<string | null> {
    const target = await this.formatTarget(sessionName);
    try {
      const result = await this.execFile(
        "tmux",
        ["display-message", "-p", "-t", target, "#{pane_current_path}"],
        { timeout: 5000 },
      );
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async capturePane(sessionName?: string): Promise<string> {
    const target = await this.formatTarget(sessionName);
    const result = await this.execFile("tmux", ["capture-pane", "-p", "-J", "-t", target], {
      timeout: 10000,
    });
    return result.stdout;
  }

  /** Like {@link capturePane} but with ANSI escapes kept (`-e`), so peek can read
   * colour meaning (dim/gray hints) before stripping. `scrollbackLines` adds that
   * many lines of history ABOVE the visible pane (`-S -N`) — the detached pane is
   * only ~24 lines tall, so peek would otherwise miss everything scrolled off. */
  async capturePaneColored(sessionName?: string, scrollbackLines?: number): Promise<string> {
    const target = await this.formatTarget(sessionName);
    const args = ["capture-pane", "-e", "-p", "-J", "-t", target];
    if (scrollbackLines && scrollbackLines > 0) args.push("-S", `-${scrollbackLines}`);
    const result = await this.execFile("tmux", args, { timeout: 10000 });
    return result.stdout;
  }

  async sendExit(sessionName?: string): Promise<void> {
    await this.sendRawKey("C-c", sessionName);
    await new Promise((r) => setTimeout(r, 300));
    await this.sendKeys("/exit", sessionName);
    await this.resetAttachedClientTerminalModes(sessionName);
  }

  async resetAttachedClientTerminalModes(sessionName?: string): Promise<void> {
    const ttys = await this.attachedClientTtys(sessionName);
    await Promise.all(
      ttys.map(async (tty) => {
        try {
          await this.writeFile(tty, TERMINAL_MODE_RESET_SEQUENCE);
        } catch {
          // Best-effort: an unattached or permission-denied client tty must not
          // make the agent exit/restart command fail.
        }
      }),
    );
  }

  private async attachedClientTtys(sessionName?: string): Promise<string[]> {
    const session = await this.resolveSessionName(sessionName);
    try {
      const result = await this.execFile(
        "tmux",
        ["list-clients", "-t", session, "-F", "#{client_tty}"],
        { timeout: 5000 },
      );
      return [
        ...new Set(
          result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(isSafeClientTty),
        ),
      ];
    } catch {
      return [];
    }
  }

  /**
   * Ensure a detached session named `sessionName` exists. Returns true if it
   * created one, false if it already existed. Race-safe: a bare `new-session`
   * throws "duplicate session" when the session appears between a caller's
   * hasSession check and this call (the `claude` helper, or two near-simultaneous
   * messages) — so an already-existing session is treated as success, not an
   * error. Only a genuine failure (tmux server down, bad name) rethrows.
   *
   * When `cwd` is given the new pane starts in that directory (`-c`). The path is
   * an argv element handed to tmux, never evaluated by a shell, so callers must
   * NOT also type a `cd "<path>"` (which would be shell-injectable on paths with
   * spaces, $, backticks, quotes or `;`).
   */
  async createSession(sessionName: string, cwd?: string): Promise<boolean> {
    const args = ["new-session", "-d", "-s", sessionName, "-e", "DISABLE_AUTO_UPDATE=true"];
    if (cwd !== undefined) args.push("-c", cwd);
    try {
      await this.execFile("tmux", args, { timeout: 10000 });
      return true;
    } catch (err) {
      if (await this.hasSession(sessionName)) return false;
      throw err;
    }
  }

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      await this.execFile("tmux", ["has-session", "-t", sessionName], { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  async killSession(sessionName: string): Promise<void> {
    try {
      await this.execFile("tmux", ["kill-session", "-t", sessionName], { timeout: 10000 });
    } catch (err) {
      if (isMissingSessionKillError(err, sessionName)) return;
      throw err;
    }
  }

  /** Map of session name -> creation epoch-seconds, via `tmux list-sessions`.
   * Best-effort: empty map if tmux isn't running. */
  async sessionsCreatedAt(): Promise<Map<string, number>> {
    try {
      const { stdout } = await this.execFile(
        "tmux",
        ["list-sessions", "-F", "#{session_name} #{session_created}"],
        { timeout: 5000 },
      );
      const out = new Map<string, number>();
      for (const line of stdout.split("\n")) {
        const [name, created] = line.trim().split(/\s+/);
        const epoch = Number.parseInt(created ?? "", 10);
        if (name && !Number.isNaN(epoch)) out.set(name, epoch);
      }
      return out;
    } catch {
      return new Map();
    }
  }

  async listProjectSessions(): Promise<string[]> {
    try {
      const result = await this.execFile("tmux", ["list-sessions", "-F", "#{session_name}"], {
        timeout: 10000,
      });
      return result.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.startsWith(this.projectSessionPrefix));
    } catch (error) {
      const msg = String(
        (error as { message?: string } | undefined)?.message ?? error,
      ).toLowerCase();
      if (msg.includes("no server running") || msg.includes("no sessions")) {
        return [];
      }
      throw error;
    }
  }
}
