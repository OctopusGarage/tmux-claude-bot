import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcRow } from "../src/core/agents/agent-config-resolver.js";
import { DEFAULT_CONFIG_ROOT } from "../src/core/agents/claude/claude-history.js";
import { listClaudeOrphans } from "../src/core/agents/claude/claude-takeover.js";
import {
  buildResumeCommand,
  createTakeoverProbe,
  findOrphans,
  isClaudeProcess,
  isPaneBusy,
  isShellForeground,
  type OrphanAgent,
  orphanLabel,
  type Signal,
  type TakeoverDeps,
  type TakeoverProbe,
  takeover,
} from "../src/core/agents/takeover.js";

// listOrphans falls back to the newest on-disk session via listClaudeSessions,
// which reads the real fs — stub it so each test pins the session id it returns.
vi.mock("../src/core/agents/claude/claude-history.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/core/agents/claude/claude-history.js")>();
  return { ...actual, listClaudeSessions: vi.fn(async () => []) };
});
const { listClaudeSessions } = await import("../src/core/agents/claude/claude-history.js");

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

describe("findOrphans (claude predicate)", () => {
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
    expect(findOrphans(rows, [10], isClaudeProcess)).toEqual([21]);
  });

  it("treats every claude as orphan when there are no tmux panes", () => {
    expect(findOrphans(rows, [], isClaudeProcess)).toEqual([11, 21]);
  });

  it("returns nothing when both claudes live under panes", () => {
    expect(findOrphans(rows, [10, 20], isClaudeProcess)).toEqual([]);
  });
});

describe("listClaudeOrphans dedup", () => {
  afterEach(() => vi.mocked(listClaudeSessions).mockReset());

  it("collapses PIDs that resume the same session into one entry carrying all pids", async () => {
    // Two independent `claude` launches in the same dir → two PIDs, same
    // newest-on-disk session → one adoptable entry, both pids retained for kill.
    const rows: ProcRow[] = [
      { pid: 21, ppid: 20, command: "claude --dangerously-skip-permissions" },
      { pid: 22, ppid: 99, command: "claude --dangerously-skip-permissions" },
    ];
    const probe: TakeoverProbe = {
      snapshot: async () => rows,
      tmuxPanePids: async () => [], // no panes → both are orphans
      cwdOf: async () => "/proj",
      openSessionFile: async () => null,
      readProcEnv: async () => "CLAUDE_CONFIG_DIR=/nonexistent-xyz", // no on-disk sessions → sessionId null
      readShellRc: async () => "",
      isAlive: async () => true,
      signal: () => {},
      sleep: async () => {},
    };
    const orphans = await listClaudeOrphans(probe);
    expect(orphans).toHaveLength(1);
    expect([...(orphans[0]?.pids ?? [])].sort()).toEqual([21, 22]);
    expect(orphans[0]?.cwd).toBe("/proj");
  });

  it("marks task state from recent transcript activity when observable", async () => {
    const rows: ProcRow[] = [
      { pid: 21, ppid: 20, command: "claude --dangerously-skip-permissions" },
      { pid: 22, ppid: 20, command: "claude --dangerously-skip-permissions" },
    ];
    const probe: TakeoverProbe = {
      snapshot: async () => rows,
      tmuxPanePids: async () => [],
      cwdOf: async (pid) => `/proj-${pid}`,
      openSessionFile: async () => null,
      readProcEnv: async () => "CLAUDE_CONFIG_DIR=/home/u/.claude",
      readShellRc: async () => "",
      isAlive: async () => true,
      signal: () => {},
      sleep: async () => {},
    };
    vi.mocked(listClaudeSessions).mockImplementation(async (projectPath) => [
      {
        sessionId: `${projectPath}-session`,
        mtime: new Date(Date.now() - (projectPath === "/proj-21" ? 1_000 : 120_000)),
      },
    ]);

    const orphans = await listClaudeOrphans(probe);

    expect(orphans.find((o) => o.pid === 21)?.busy).toBe(true);
    expect(orphans.find((o) => o.pid === 22)?.busy).toBe(false);
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

const ORPHAN: OrphanAgent = {
  pid: 42,
  cwd: "/proj",
  configRoot: DEFAULT_CONFIG_ROOT,
  sessionId: "sess-1",
  startCommand: "/bin/claude --resume sess-1 --dangerously-skip-permissions",
  agent: "claude",
};

function deps(probe: TakeoverProbe, over: Partial<TakeoverDeps> = {}): TakeoverDeps {
  return {
    probe,
    isTargetBusy: vi.fn(async () => false),
    ensureSession: vi.fn(async () => "tcb-proj"),
    startInSession: vi.fn(async () => {}),
    isAgentRunning: vi.fn(async () => true),
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
    const res = await takeover(ORPHAN, deps(probe, { isAgentRunning: vi.fn(async () => false) }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("agent_did_not_start");
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
    const isAgentRunning = vi.fn(async () => readiness.shift() ?? true);
    const res = await takeover(ORPHAN, deps(probe, { isAgentRunning }));
    expect(res.ok).toBe(true);
    expect(isAgentRunning).toHaveBeenCalledTimes(3);
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

  it("openSessionFile also extracts a CODEX rollout's session id (orphan takeover parity)", async () => {
    const intro = {
      snapshot: async () => [],
      readProcEnv: async () => "",
      listOpenFiles: async () => [
        "/dev/null",
        "/home/u/.codex/sessions/2026/06/17/rollout-2026-06-17T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
      ],
      cwdOf: async () => "/home/u/project",
    };
    const probe = createTakeoverProbe(intro);
    expect(await probe.openSessionFile(200)).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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

  it("snapshot / readProcEnv / isAlive delegate to the introspector", async () => {
    const rows: ProcRow[] = [{ pid: 1, ppid: 0, command: "claude" }];
    const intro = {
      snapshot: vi.fn(async () => rows),
      readProcEnv: vi.fn(async () => "CLAUDE_CONFIG_DIR=/x"),
      listOpenFiles: async () => [],
      cwdOf: async () => null,
    };
    const probe = createTakeoverProbe(intro);
    expect(await probe.snapshot()).toBe(rows);
    expect(await probe.readProcEnv(5)).toBe("CLAUDE_CONFIG_DIR=/x");
    // isAlive(pid 0) → process.kill(0,0) inspects the whole group; a clearly dead
    // pid is reliably false.
    expect(await probe.isAlive(2_147_483_646)).toBe(false);
    expect(intro.readProcEnv).toHaveBeenCalledWith(5);
  });

  it("tmuxPanePids returns null when the tmux query fails", async () => {
    // tmux is invoked with a bogus flag so it exits non-zero regardless of env;
    // the catch must map any failure to null (distinct from [] = no panes).
    const probe = createTakeoverProbe({
      snapshot: async () => [],
      readProcEnv: async () => "",
      listOpenFiles: async () => [],
      cwdOf: async () => null,
    });
    const orig = process.env.PATH;
    process.env.PATH = "/nonexistent"; // tmux not found → execFile rejects
    try {
      expect(await probe.tmuxPanePids()).toBeNull();
    } finally {
      process.env.PATH = orig;
    }
  });

  it("signal swallows ESRCH for an already-gone pid", () => {
    const probe = createTakeoverProbe({
      snapshot: async () => [],
      readProcEnv: async () => "",
      listOpenFiles: async () => [],
      cwdOf: async () => null,
    });
    // A pid that does not exist → process.kill throws ESRCH → must be swallowed.
    expect(() => probe.signal(2_147_483_646, "SIGTERM")).not.toThrow();
  });
});

describe("orphanLabel", () => {
  it("shows the project dir and a short session hint when resumable", () => {
    expect(
      orphanLabel({
        pid: 1,
        cwd: "/home/u/my-project",
        configRoot: DEFAULT_CONFIG_ROOT,
        sessionId: "12345678-aaaa-bbbb-cccc-dddddddddddd",
        startCommand: "claude",
        agent: "claude",
      }),
    ).toBe("Claude · my-project · 12345678 · task unknown");
  });

  it("marks a fresh (no-session) orphan as new", () => {
    expect(
      orphanLabel({
        pid: 1,
        cwd: "/home/u/my-project",
        configRoot: DEFAULT_CONFIG_ROOT,
        sessionId: null,
        startCommand: "claude",
        agent: "claude",
      }),
    ).toBe("Claude · my-project · new · task unknown");
  });

  it("shows codex and known task state when available", () => {
    expect(
      orphanLabel({
        pid: 1,
        cwd: "/home/u/my-project",
        configRoot: "/home/u/.codex",
        sessionId: "87654321-aaaa-bbbb-cccc-dddddddddddd",
        startCommand: "codex resume 87654321-aaaa-bbbb-cccc-dddddddddddd",
        agent: "codex",
        busy: true,
      }),
    ).toBe("Codex · my-project · 87654321 · task busy");
  });
});

describe("listClaudeOrphans", () => {
  afterEach(() => vi.mocked(listClaudeSessions).mockReset());

  function probeFor(over: Partial<TakeoverProbe>): TakeoverProbe {
    return {
      snapshot: async () => [],
      tmuxPanePids: async () => [],
      cwdOf: async () => "/proj",
      openSessionFile: async () => null,
      readProcEnv: async () => "",
      readShellRc: async () => "",
      isAlive: async () => false,
      signal: () => {},
      sleep: async () => {},
      ...over,
    };
  }

  it("bails (empty) when tmux can't be queried (panePids null)", async () => {
    const snapshot = vi.fn(async () => [{ pid: 9, ppid: 1, command: "claude" }] as ProcRow[]);
    const out = await listClaudeOrphans(probeFor({ snapshot, tmuxPanePids: async () => null }));
    expect(out).toEqual([]);
  });

  it("drops an orphan with no resolvable cwd (can't resume without a project dir)", async () => {
    const out = await listClaudeOrphans(
      probeFor({
        snapshot: async () => [{ pid: 9, ppid: 1, command: "claude" }],
        tmuxPanePids: async () => [],
        cwdOf: async () => null,
      }),
    );
    expect(out).toEqual([]);
  });

  it("prefers the exact open session file over the newest on disk", async () => {
    vi.mocked(listClaudeSessions).mockResolvedValue([{ sessionId: "on-disk", mtime: new Date(1) }]);
    const out = await listClaudeOrphans(
      probeFor({
        snapshot: async () => [{ pid: 9, ppid: 1, command: "/usr/bin/claude --resume x" }],
        tmuxPanePids: async () => [],
        cwdOf: async () => "/proj",
        openSessionFile: async () => "exact-open",
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.sessionId).toBe("exact-open");
    // No alias match → reconstructed command using the orphan's own binary.
    expect(out[0]?.startCommand).toBe("/usr/bin/claude --resume exact-open");
  });

  it("falls back to the newest on-disk session when none is held open", async () => {
    vi.mocked(listClaudeSessions).mockResolvedValue([
      { sessionId: "newest-disk", mtime: new Date(9) },
    ]);
    const out = await listClaudeOrphans(
      probeFor({
        snapshot: async () => [{ pid: 9, ppid: 1, command: "claude" }],
        tmuxPanePids: async () => [],
        openSessionFile: async () => null,
      }),
    );
    expect(out[0]?.sessionId).toBe("newest-disk");
  });

  it("uses null session (start fresh) when nothing is open and nothing on disk", async () => {
    vi.mocked(listClaudeSessions).mockResolvedValue([]);
    const out = await listClaudeOrphans(
      probeFor({
        snapshot: async () => [{ pid: 9, ppid: 1, command: "claude" }],
        tmuxPanePids: async () => [],
        openSessionFile: async () => null,
      }),
    );
    expect(out[0]?.sessionId).toBeNull();
    expect(out[0]?.startCommand).toBe("claude"); // bare, no --resume
  });

  it("relaunches via a matched flavor alias instead of a reconstructed command", async () => {
    vi.mocked(listClaudeSessions).mockResolvedValue([]);
    const home = process.env.HOME ?? "/home/u";
    const out = await listClaudeOrphans(
      probeFor({
        snapshot: async () => [{ pid: 9, ppid: 1, command: "claude" }],
        tmuxPanePids: async () => [],
        openSessionFile: async () => "sess-7",
        // env signature: config dir ~/.claude-stella, no base url.
        readProcEnv: async () => `CLAUDE_CONFIG_DIR=${home}/.claude-stella`,
        readShellRc: async () => `alias claude-stella="CLAUDE_CONFIG_DIR=~/.claude-stella claude"`,
      }),
    );
    expect(out[0]?.startCommand).toBe("claude-stella --resume sess-7");
    expect(out[0]?.configRoot).toBe(`${home}/.claude-stella`);
  });
});
