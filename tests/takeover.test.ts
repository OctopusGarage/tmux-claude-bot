import { describe, expect, it, vi } from "vitest";
import type { ProcRow } from "../src/core/claude-config-resolver.js";
import { DEFAULT_CONFIG_ROOT } from "../src/core/history.js";
import {
  buildResumeCommand,
  createTakeoverProbe,
  findOrphanClaudes,
  isClaudeProcess,
  isPaneBusy,
  isShellForeground,
  type OrphanClaude,
  type Signal,
  type TakeoverDeps,
  type TakeoverProbe,
  takeover,
} from "../src/core/takeover.js";

describe("isClaudeProcess", () => {
  it("matches a bare claude and an absolute-path claude", () => {
    expect(isClaudeProcess("claude --dangerously-skip-permissions")).toBe(true);
    expect(isClaudeProcess("/Users/x/.local/bin/claude --resume abc")).toBe(true);
  });

  it("matches flavor wrapper names", () => {
    expect(isClaudeProcess("claude-stella")).toBe(true);
    expect(isClaudeProcess("/opt/bin/claude-ollama foo")).toBe(true);
  });

  it("does not match when claude only appears as an argument", () => {
    expect(isClaudeProcess("vim claude.ts")).toBe(false);
    expect(isClaudeProcess("node build-claude.js")).toBe(false);
    expect(isClaudeProcess("")).toBe(false);
  });
});

describe("findOrphanClaudes", () => {
  // tmux server (1) -> pane shell (10) -> claude (11)   [in tmux]
  // login shell (20) -> claude (21)                     [orphan]
  // editor (30) referencing claude in args              [ignored]
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, command: "-zsh" },
    { pid: 11, ppid: 10, command: "claude --dangerously-skip-permissions" },
    { pid: 20, ppid: 1, command: "login -pf user" },
    { pid: 21, ppid: 20, command: "/Users/x/.local/bin/claude" },
    { pid: 30, ppid: 1, command: "vim claude.ts" },
  ];

  it("returns claude pids not reachable from any tmux pane pid", () => {
    expect(findOrphanClaudes(rows, [10])).toEqual([21]);
  });

  it("treats every claude as orphan when there are no tmux panes", () => {
    expect(findOrphanClaudes(rows, [])).toEqual([11, 21]);
  });

  it("returns nothing when both claudes live under panes", () => {
    expect(findOrphanClaudes(rows, [10, 20])).toEqual([]);
  });
});

describe("isShellForeground", () => {
  it("treats shells (incl. login -zsh and absolute paths) as idle", () => {
    for (const c of ["zsh", "bash", "-zsh", "fish", "/bin/bash", "sh"]) {
      expect(isShellForeground(c)).toBe(true);
    }
  });

  it("treats a running program (claude / node / editor) as occupied", () => {
    for (const c of ["claude", "node", "vim", "nvim", "python"]) {
      expect(isShellForeground(c)).toBe(false);
    }
  });
});

describe("isPaneBusy", () => {
  it("is not busy for an idle shell", () => {
    expect(isPaneBusy("zsh")).toBe(false);
  });

  it("is busy for a running program", () => {
    expect(isPaneBusy("claude")).toBe(true);
    expect(isPaneBusy("vim")).toBe(true);
  });

  it("is NOT busy when the foreground can't be read (null) — proceed, don't block", () => {
    expect(isPaneBusy(null)).toBe(false);
  });
});

describe("buildResumeCommand", () => {
  it("starts fresh (no --resume) without escalating permissions", () => {
    expect(
      buildResumeCommand("/bin/claude", {
        configRoot: DEFAULT_CONFIG_ROOT,
        sessionId: null,
        skipPermissions: false,
      }),
    ).toBe("/bin/claude");
  });

  it("carries over the yolo flag only when the original had it", () => {
    expect(
      buildResumeCommand("claude", {
        configRoot: DEFAULT_CONFIG_ROOT,
        sessionId: "uuid-1",
        skipPermissions: true,
      }),
    ).toBe("claude --resume uuid-1 --dangerously-skip-permissions");
  });

  it("exports CLAUDE_CONFIG_DIR for a non-default flavor root", () => {
    expect(
      buildResumeCommand("claude", {
        configRoot: "/home/me/.claude-stella",
        sessionId: "uuid-2",
        skipPermissions: false,
      }),
    ).toBe("CLAUDE_CONFIG_DIR=/home/me/.claude-stella claude --resume uuid-2");
  });
});

/** A probe whose liveness answers come from a scripted queue, recording the
 * exact order of signals sent. */
function fakeProbe(opts: { alive?: boolean[] }): {
  probe: TakeoverProbe;
  signals: Array<[number, Signal]>;
} {
  const alive = [...(opts.alive ?? [])];
  const signals: Array<[number, Signal]> = [];
  const probe: TakeoverProbe = {
    snapshot: async () => [],
    tmuxPanePids: async () => [],
    cwdOf: async () => null,
    openSessionFile: async () => null,
    readProcEnv: async () => "",
    readShellRc: async () => "",
    isAlive: async () => alive.shift() ?? false,
    signal: (pid, sig) => {
      signals.push([pid, sig]);
    },
    sleep: async () => {},
  };
  return { probe, signals };
}

const ORPHAN: OrphanClaude = {
  pid: 42,
  cwd: "/proj",
  configRoot: DEFAULT_CONFIG_ROOT,
  sessionId: "sess-1",
  startCommand: "/bin/claude --resume sess-1 --dangerously-skip-permissions",
};

function deps(probe: TakeoverProbe, over: Partial<TakeoverDeps> = {}): TakeoverDeps {
  return {
    probe,
    isTargetBusy: vi.fn(async () => false),
    ensureSession: vi.fn(async () => "tcb-proj"),
    startInSession: vi.fn(async () => {}),
    isClaudeRunning: vi.fn(async () => true),
    ...over,
  };
}

describe("takeover", () => {
  it("SIGINT then SIGTERM, resumes, and reports ok when claude comes up", async () => {
    // alive after SIGINT, dead after SIGTERM.
    const { probe, signals } = fakeProbe({ alive: [true, false] });
    const d = deps(probe);
    const res = await takeover(ORPHAN, d);

    expect(signals).toEqual([
      [42, "SIGINT"],
      [42, "SIGTERM"],
    ]);
    expect(d.ensureSession).toHaveBeenCalledWith("/proj");
    expect(d.startInSession).toHaveBeenCalledWith(
      "tcb-proj",
      "/bin/claude --resume sess-1 --dangerously-skip-permissions",
    );
    expect(res).toEqual({ ok: true, sessionName: "tcb-proj", resumed: true });
  });

  it("escalates to SIGKILL and fails when the process will not die", async () => {
    const { probe, signals } = fakeProbe({ alive: [true, true, true] });
    const d = deps(probe);
    const res = await takeover(ORPHAN, d);

    expect(signals).toEqual([
      [42, "SIGINT"],
      [42, "SIGTERM"],
      [42, "SIGKILL"],
    ]);
    expect(d.ensureSession).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("process_would_not_die");
  });

  it("reports a failure reason when claude does not start after resume", async () => {
    const { probe } = fakeProbe({ alive: [false] });
    const res = await takeover(ORPHAN, deps(probe, { isClaudeRunning: vi.fn(async () => false) }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("claude_did_not_start");
  });

  it("aborts without touching the orphan when the target session is busy", async () => {
    const { probe, signals } = fakeProbe({ alive: [true, false] });
    const d = deps(probe, { isTargetBusy: vi.fn(async () => true) });
    const res = await takeover(ORPHAN, d);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("target_session_busy");
    expect(signals).toEqual([]); // orphan never signalled
    expect(d.ensureSession).not.toHaveBeenCalled();
  });

  it("polls for readiness — succeeds once claude appears after a delay", async () => {
    const { probe } = fakeProbe({ alive: [true, false] });
    // claude isn't visible on the first two checks, then spawns.
    const readiness = [false, false, true];
    const isClaudeRunning = vi.fn(async () => readiness.shift() ?? true);
    const res = await takeover(ORPHAN, deps(probe, { isClaudeRunning }));
    expect(res.ok).toBe(true);
    expect(isClaudeRunning).toHaveBeenCalledTimes(3);
  });

  it("types the orphan's resolved start command verbatim (e.g. a flavor alias)", async () => {
    const { probe } = fakeProbe({ alive: [false] });
    const d = deps(probe);
    await takeover({ ...ORPHAN, startCommand: "claude-stella --resume sess-9" }, d);
    expect(d.startInSession).toHaveBeenCalledWith("tcb-proj", "claude-stella --resume sess-9");
  });
});

describe("createTakeoverProbe composition", () => {
  it("openSessionFile extracts the session id from the introspector's open files", async () => {
    const intro = {
      snapshot: async () => [],
      readProcEnv: async () => "",
      listOpenFiles: async () => [
        "/dev/null",
        "/home/u/.claude/projects/foo/12345678-1234-1234-1234-123456789abc.jsonl",
      ],
      cwdOf: async () => "/home/u/project",
    };
    const probe = createTakeoverProbe(intro);
    expect(await probe.openSessionFile(200)).toBe("12345678-1234-1234-1234-123456789abc");
    expect(await probe.cwdOf(200)).toBe("/home/u/project");
  });

  it("openSessionFile returns null when no jsonl is open", async () => {
    const intro = {
      snapshot: async () => [],
      readProcEnv: async () => "",
      listOpenFiles: async () => ["/dev/null", "/tmp/socket"],
      cwdOf: async () => null,
    };
    const probe = createTakeoverProbe(intro);
    expect(await probe.openSessionFile(200)).toBeNull();
  });
});
