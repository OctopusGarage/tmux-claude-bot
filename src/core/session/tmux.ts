import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const execFileAsync = promisify(execFile);

function defaultExecFile(file: string, args: string[], options?: { timeout?: number }) {
  return execFileAsync(file, args, { timeout: options?.timeout });
}

export class TmuxBridge {
  private readonly execFile: ExecFileLike;
  private getSessionName: () => Promise<string>;
  private readonly window: number;
  private readonly pane: number;
  private readonly projectSessionPrefix: string;

  constructor(options: {
    execFile?: ExecFileLike;
    getSessionName: () => Promise<string>;
    window?: number;
    pane?: number;
    projectSessionPrefix?: string;
  }) {
    this.execFile = options.execFile ?? defaultExecFile;
    this.getSessionName = options.getSessionName;
    this.window = options.window ?? 0;
    this.pane = options.pane ?? 0;
    this.projectSessionPrefix = options.projectSessionPrefix ?? "tmux_proj_";
  }

  private async formatTarget(sessionName?: string): Promise<string> {
    const session = sessionName ?? (await this.getSessionName());
    return `${session}:${this.window}.${this.pane}`;
  }

  /** Resolve an explicit session name, or the configured default when omitted. */
  resolveSessionName(sessionName?: string): Promise<string> {
    return sessionName !== undefined ? Promise.resolve(sessionName) : this.getSessionName();
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
   * Type `text` into the pane line by line, pressing Enter after each line.
   *
   * The text content is sent with `-l` (literal) so tmux types it verbatim instead
   * of interpreting a token as a key name — a line that happens to equal "Up",
   * "Enter", "Tab" or "C-c" must be typed, not pressed. The newline is a separate
   * un-flagged `Enter` (the key). For named keys use `sendRawKey`.
   */
  async sendKeys(text: string, sessionName?: string): Promise<void> {
    const target = await this.formatTarget(sessionName);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const isLastLine = i === lines.length - 1;
      const line = lines[i];
      if (line) {
        await this.execFile("tmux", ["send-keys", "-t", target, "-l", line], { timeout: 10000 });
      }
      if (line || isLastLine) {
        await this.execFile("tmux", ["send-keys", "-t", target, "Enter"], { timeout: 10000 });
      }
    }
  }

  async sendRawKey(key: string, sessionName?: string): Promise<void> {
    const target = await this.formatTarget(sessionName);
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

  async sendExit(sessionName?: string): Promise<void> {
    await this.sendRawKey("C-c", sessionName);
    await new Promise((r) => setTimeout(r, 300));
    await this.sendKeys("/exit", sessionName);
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
    const args = ["new-session", "-d", "-s", sessionName];
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
    await this.execFile("tmux", ["kill-session", "-t", sessionName], { timeout: 10000 });
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
