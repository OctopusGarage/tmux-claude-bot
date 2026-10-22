import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResolver, ProcRow } from "../../src/core/agents/agent-config-resolver.js";
import { DEFAULT_CONFIG_ROOT } from "../../src/core/agents/claude/claude-history.js";
import type { OrphanAgent, TakeoverDeps, TakeoverResult } from "../../src/core/agents/takeover.js";
import { messages } from "../../src/core/i18n/index.js";
import type { TmuxBridge } from "../../src/core/session/tmux.js";

// takeover-service is wiring: it composes a probe + bridge + resolver into the
// pure takeover() orchestration. Mock the takeover module (probe/takeover),
// claude-takeover (listClaudeOrphans) + codex-takeover (listCodexOrphans), the
// clipboard, and the session→path map so each branch is driven without the OS.
const takeover = vi.fn<(o: OrphanAgent, d: TakeoverDeps) => Promise<TakeoverResult>>();
// Probe used by claudeConfigDirsInUse (snapshot + readProcEnv). Empty by default.
const probeSnapshot = vi.fn<() => Promise<ProcRow[]>>(async () => []);
const probeReadProcEnv = vi.fn<(pid: number) => Promise<string>>(async () => "");
vi.mock("../../src/core/agents/takeover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/agents/takeover.js")>();
  return {
    ...actual,
    createTakeoverProbe: () =>
      ({ snapshot: probeSnapshot, readProcEnv: probeReadProcEnv }) as never,
    takeover: (...a: unknown[]) => takeover(...(a as Parameters<typeof takeover>)),
  };
});

const listClaudeOrphans = vi.fn<() => Promise<OrphanAgent[]>>();
vi.mock("../../src/core/agents/claude/claude-takeover.js", () => ({
  listClaudeOrphans: (...a: unknown[]) => listClaudeOrphans(...(a as [])),
}));

// listCodexOrphans always returns empty by default — codex orphan behaviour is
// tested in codex-takeover.test.ts; here we only need it not to interfere.
const listCodexOrphans = vi.fn<() => Promise<OrphanAgent[]>>(async () => []);
vi.mock("../../src/core/agents/codex/codex-takeover.js", () => ({
  listCodexOrphans: (...a: unknown[]) => listCodexOrphans(...(a as [])),
}));

const copyToClipboard = vi.fn(async () => {});
vi.mock("../../src/core/platform/clipboard.js", () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...(a as [])),
}));

const freeProject = vi.hoisted(() => ({
  allocateFreeSlot: vi.fn<() => number | null>(() => 1),
  setFreeProject: vi.fn(),
}));
vi.mock("../../src/core/projects/free-projects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/projects/free-projects.js")>();
  return {
    ...actual,
    allocateFreeSlot: () => freeProject.allocateFreeSlot(),
    setFreeProject: (...a: unknown[]) =>
      freeProject.setFreeProject(...(a as Parameters<typeof actual.setFreeProject>)),
  };
});

const getPathBySession = vi.fn<(s: string) => string | null>(() => null);
const setPathForSession = vi.fn();
vi.mock("../../src/core/projects/sessionPathMap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/projects/sessionPathMap.js")>();
  return {
    ...actual,
    getPathBySession: (s: string) => getPathBySession(s),
    setPathForSession: (s: string, p: string) => setPathForSession(s, p),
  };
});

const {
  adoptOrphan,
  attachCommand,
  claudeConfigDirsInUse,
  composeAdoptOutcome,
  copyAttachCommand,
  findAdoptableOrphans,
} = await import("../../src/core/agents/takeover-service.js");

const ORPHAN: OrphanAgent = {
  pid: 42,
  cwd: "/home/u/proj",
  configRoot: "/home/u/.claude",
  sessionId: "sess-1",
  startCommand: "claude --resume sess-1",
  agent: "claude",
};

beforeEach(() => {
  listClaudeOrphans.mockReset();
  listCodexOrphans.mockReset().mockResolvedValue([]);
  takeover.mockReset();
  copyToClipboard.mockClear();
  freeProject.allocateFreeSlot.mockReset().mockReturnValue(1);
  freeProject.setFreeProject.mockReset();
  getPathBySession.mockReset().mockReturnValue(null);
  setPathForSession.mockReset();
  probeSnapshot.mockReset().mockResolvedValue([]);
  probeReadProcEnv.mockReset().mockResolvedValue("");
});

describe("claudeConfigDirsInUse", () => {
  it("dedupes config roots across running claudes, defaulting an absent dir", async () => {
    probeSnapshot.mockResolvedValue([
      { pid: 1, ppid: 0, command: "claude" }, // no CLAUDE_CONFIG_DIR → default
      { pid: 2, ppid: 0, command: "claude-stella" }, // stella root
      { pid: 3, ppid: 0, command: "vim" }, // not a claude → filtered out
      { pid: 4, ppid: 0, command: "claude" }, // default again → deduped
    ]);
    probeReadProcEnv.mockImplementation(async (pid) =>
      pid === 2 ? "CLAUDE_CONFIG_DIR=/home/u/.claude-stella" : "",
    );
    const dirs = await claudeConfigDirsInUse();
    expect(dirs).toEqual([DEFAULT_CONFIG_ROOT, "/home/u/.claude-stella"]);
    // pid 3 (vim) was filtered before any env probe; only claude rows are probed.
    expect(probeReadProcEnv).toHaveBeenCalledTimes(3);
  });

  it("returns an empty list when no claude is running", async () => {
    probeSnapshot.mockResolvedValue([{ pid: 9, ppid: 0, command: "node server.js" }]);
    expect(await claudeConfigDirsInUse()).toEqual([]);
  });
});

describe("attachCommand", () => {
  it("builds a tmux attach command, shell-quoting the session name", () => {
    expect(attachCommand("tcb-home-u-proj")).toBe("tmux attach -t 'tcb-home-u-proj'");
  });

  it("escapes embedded single quotes safely", () => {
    expect(attachCommand("a'b")).toBe("tmux attach -t 'a'\\''b'");
  });
});

describe("copyAttachCommand", () => {
  it("returns the attach command and fires a best-effort clipboard copy", () => {
    const cmd = copyAttachCommand("tcb-proj");
    expect(cmd).toBe("tmux attach -t 'tcb-proj'");
    expect(copyToClipboard).toHaveBeenCalledWith("tmux attach -t 'tcb-proj'");
  });
});

describe("composeAdoptOutcome", () => {
  const m = messages("telegram");

  it("reports gone when the process is no longer adoptable (null result)", () => {
    expect(composeAdoptOutcome(null, "telegram")).toEqual({
      ok: false,
      body: m.adoptGone,
      sessionName: "",
    });
  });

  it("maps the busy reason to the busy message", () => {
    const out = composeAdoptOutcome(
      { ok: false, sessionName: "tcb-x", resumed: false, reason: "target_session_busy" },
      "telegram",
    );
    expect(out).toEqual({ ok: false, body: m.adoptBusy, sessionName: "tcb-x" });
  });

  it("maps a running same-project agent to the duplicate-project message", () => {
    const out = composeAdoptOutcome(
      { ok: false, sessionName: "tcb-x", resumed: false, reason: "project_agent_running" },
      "telegram",
    );
    expect(out).toEqual({ ok: false, body: m.adoptProjectRunning, sessionName: "tcb-x" });
  });

  it("maps a full free-project registry to the free-project limit message", () => {
    const out = composeAdoptOutcome(
      { ok: false, sessionName: "", resumed: false, reason: "free_project_limit" },
      "telegram",
    );
    expect(out).toEqual({ ok: false, body: m.freeProjectLimit(10), sessionName: "" });
  });

  it("maps other failures to the generic failed message", () => {
    const out = composeAdoptOutcome(
      { ok: false, sessionName: "tcb-x", resumed: false, reason: "process_would_not_die" },
      "telegram",
    );
    expect(out.body).toBe(m.adoptFailed);
    expect(out.ok).toBe(false);
  });

  it("on success uses the mapped path's basename and the resumed flag", () => {
    getPathBySession.mockReturnValue("/home/u/my-project");
    const out = composeAdoptOutcome({ ok: true, sessionName: "tcb-x", resumed: true }, "telegram");
    expect(out.ok).toBe(true);
    expect(out.sessionName).toBe("tcb-x");
    expect(out.body).toBe(m.adoptDone("my-project", true));
  });

  it("falls back to the session name when no path is mapped, and shows new-session copy", () => {
    getPathBySession.mockReturnValue(null);
    const out = composeAdoptOutcome(
      { ok: true, sessionName: "tcb-fallback", resumed: false },
      "telegram",
    );
    expect(out.body).toBe(m.adoptDone("tcb-fallback", false));
  });
});

describe("findAdoptableOrphans", () => {
  it("merges claude and codex orphan lists", async () => {
    const codexOrphan: OrphanAgent = { ...ORPHAN, pid: 99, agent: "codex" };
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    listCodexOrphans.mockResolvedValue([codexOrphan]);
    expect(await findAdoptableOrphans()).toEqual([ORPHAN, codexOrphan]);
  });

  it("returns claude orphans only when there are no codex orphans", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    expect(await findAdoptableOrphans()).toEqual([ORPHAN]);
  });
});

describe("adoptOrphan", () => {
  function ctx(over: Partial<TmuxBridge> = {}, resolverRunning = true) {
    const bridge = {
      hasSession: vi.fn(async () => false),
      createSession: vi.fn(async () => true),
      sendKeys: vi.fn(async () => {}),
      paneCurrentCommand: vi.fn(async () => null),
      listProjectSessions: vi.fn(async () => []),
      ...over,
    } as unknown as TmuxBridge;
    const configResolver = {
      isClaudeRunning: vi.fn(async () => resolverRunning),
      isCodexRunning: vi.fn(async () => false),
    } as unknown as ConfigResolver;
    return {
      bridge,
      configResolver,
      projectSessionPrefix: "tcb-",
      warmupMs: 0,
    };
  }

  it("returns null when the tapped pid is no longer in the (re-scanned) orphan list", async () => {
    listClaudeOrphans.mockResolvedValue([{ ...ORPHAN, pid: 99 }]);
    expect(await adoptOrphan(42, ctx())).toBeNull();
    expect(takeover).not.toHaveBeenCalled();
  });

  it("wires the bridge/resolver into takeover and returns its result", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    const result: TakeoverResult = { ok: true, sessionName: "tcb-proj", resumed: true };
    takeover.mockResolvedValue(result);
    expect(await adoptOrphan(42, ctx())).toBe(result);
    expect(takeover).toHaveBeenCalledWith(
      ORPHAN,
      expect.objectContaining({
        isTargetBusy: expect.any(Function),
        ensureSession: expect.any(Function),
        startInSession: expect.any(Function),
        isAgentRunning: expect.any(Function),
      }),
    );
  });

  it("records the adopted session's agent kind so a codex session routes correctly", async () => {
    const codexOrphan: OrphanAgent = { ...ORPHAN, pid: 99, agent: "codex" };
    listClaudeOrphans.mockResolvedValue([]);
    listCodexOrphans.mockResolvedValue([codexOrphan]);
    takeover.mockResolvedValue({ ok: true, sessionName: "tcb-codex", resumed: true });
    await adoptOrphan(99, ctx());
    const { getAgentKind } = await import("../../src/core/agents/agentKindMap.js");
    expect(getAgentKind("tcb-codex")).toBe("codex");
  });

  it("does not record agent kind when the takeover fails", async () => {
    listClaudeOrphans.mockResolvedValue([{ ...ORPHAN, pid: 77, agent: "codex" }]);
    takeover.mockResolvedValue({ ok: false, sessionName: "tcb-fail", resumed: false });
    await adoptOrphan(77, ctx());
    const { getAgentKind } = await import("../../src/core/agents/agentKindMap.js");
    expect(getAgentKind("tcb-fail")).toBe("claude"); // default — nothing recorded
  });

  it("reports agent startup failures with a pane-inspection hint", () => {
    const outcome = composeAdoptOutcome(
      {
        ok: false,
        sessionName: "tcb-fail",
        resumed: true,
        reason: "agent_did_not_start",
      },
      "telegram:1",
    );

    expect(outcome).toEqual({
      ok: false,
      body: messages("telegram").adoptAgentDidNotStart,
      sessionName: "tcb-fail",
    });
  });

  it("isTargetBusy: false when no session exists", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    const c = ctx({ hasSession: vi.fn(async () => false) });
    takeover.mockImplementation(async (_o, d) => {
      expect(await d.isTargetBusy("/home/u/proj")).toBe(false);
      return { ok: true, sessionName: "s", resumed: false };
    });
    await adoptOrphan(42, c);
  });

  it("blocks a path takeover when another same-path session is running an agent", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    getPathBySession.mockImplementation((session) =>
      session === "tcb-existing" ? "/home/u/proj" : null,
    );
    const c = ctx({ listProjectSessions: vi.fn(async () => ["tcb-existing"]) }, true);

    const result = await adoptOrphan(42, c);

    expect(result).toEqual({
      ok: false,
      sessionName: "tcb-existing",
      resumed: false,
      reason: "project_agent_running",
    });
    expect(takeover).not.toHaveBeenCalled();
  });

  it("allows a free takeover even when another same-path session is running an agent", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    getPathBySession.mockImplementation((session) =>
      session === "tcb-existing" ? "/home/u/proj" : null,
    );
    const createSession = vi.fn(async () => true);
    const c = ctx(
      { listProjectSessions: vi.fn(async () => ["tcb-existing"]), createSession },
      true,
    );
    takeover.mockImplementation(async (_o, d) => {
      const name = await d.ensureSession("/home/u/proj");
      expect(name).toBe("tcb-free_1");
      return { ok: true, sessionName: name, resumed: true };
    });

    const result = await adoptOrphan(42, c, { target: "free" });

    expect(result?.ok).toBe(true);
    expect(createSession).toHaveBeenCalledWith("tcb-free_1", "/home/u/proj");
    expect(freeProject.setFreeProject).toHaveBeenCalledWith(1, { label: null });
    expect(setPathForSession).toHaveBeenCalledWith("tcb-free_1", "/home/u/proj");
  });

  it("blocks a free takeover before touching the orphan when free slots are full", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    freeProject.allocateFreeSlot.mockReturnValue(null);

    const result = await adoptOrphan(42, ctx(), { target: "free" });

    expect(result).toEqual({
      ok: false,
      sessionName: "",
      resumed: false,
      reason: "free_project_limit",
    });
    expect(takeover).not.toHaveBeenCalled();
  });

  it("isTargetBusy: true when the existing session has a non-shell foreground", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    const c = ctx({
      hasSession: vi.fn(async () => true),
      paneCurrentCommand: vi.fn(async () => "vim"),
    });
    takeover.mockImplementation(async (_o, d) => {
      expect(await d.isTargetBusy("/home/u/proj")).toBe(true);
      return { ok: false, sessionName: "", resumed: false, reason: "target_session_busy" };
    });
    await adoptOrphan(42, c);
  });

  it("ensureSession creates a missing session, records its path, and returns its name", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    const createSession = vi.fn(async () => true);
    const c = ctx({ hasSession: vi.fn(async () => false), createSession });
    takeover.mockImplementation(async (_o, d) => {
      const name = await d.ensureSession("/home/u/proj");
      expect(name).toBe("tcb--home-u-proj");
      expect(createSession).toHaveBeenCalledWith("tcb--home-u-proj", "/home/u/proj");
      expect(setPathForSession).toHaveBeenCalledWith("tcb--home-u-proj", "/home/u/proj");
      return { ok: true, sessionName: name, resumed: false };
    });
    await adoptOrphan(42, c);
  });

  it("ensureSession reuses an existing session without creating it", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    const createSession = vi.fn(async () => true);
    const c = ctx({ hasSession: vi.fn(async () => true), createSession });
    takeover.mockImplementation(async (_o, d) => {
      await d.ensureSession("/home/u/proj");
      expect(createSession).not.toHaveBeenCalled();
      return { ok: true, sessionName: "x", resumed: false };
    });
    await adoptOrphan(42, c);
  });

  it("startInSession types the command, isClaudeRunning consults the resolver", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    const sendKeys = vi.fn(async () => {});
    const c = ctx({ sendKeys }, false);
    takeover.mockImplementation(async (_o, d) => {
      await d.startInSession("tcb-x", "claude --resume sess-1");
      expect(sendKeys).toHaveBeenCalledWith("claude --resume sess-1", "tcb-x");
      expect(await d.isAgentRunning("tcb-x")).toBe(false);
      return { ok: false, sessionName: "tcb-x", resumed: false, reason: "agent_did_not_start" };
    });
    await adoptOrphan(42, c);
  });

  it("rejects a concurrent adopt of the same pid (in-flight guard returns null)", async () => {
    listClaudeOrphans.mockResolvedValue([ORPHAN]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    takeover.mockImplementation(async () => {
      await gate;
      return { ok: true, sessionName: "tcb-x", resumed: false };
    });
    const first = adoptOrphan(42, ctx());
    const second = await adoptOrphan(42, ctx()); // while first is still running
    expect(second).toBeNull();
    release();
    await first;
    // After the first completes the guard is cleared — a later adopt runs again.
    listClaudeOrphans.mockResolvedValue([]);
    expect(await adoptOrphan(42, ctx())).toBeNull();
    expect(listClaudeOrphans).toHaveBeenCalledTimes(2); // first + the post-release retry
  });
});
