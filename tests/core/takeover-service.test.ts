import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResolver, ProcRow } from "../../src/core/claude-config-resolver.js";
import { DEFAULT_CONFIG_ROOT } from "../../src/core/history.js";
import { messages } from "../../src/core/i18n/index.js";
import type { OrphanClaude, TakeoverDeps, TakeoverResult } from "../../src/core/takeover.js";
import type { TmuxBridge } from "../../src/core/tmux.js";

// takeover-service is wiring: it composes a probe + bridge + resolver into the
// pure takeover() orchestration. Mock the takeover module (probe/listOrphans/
// takeover), the clipboard, and the session→path map so each branch is driven
// without touching the OS.
const listOrphans = vi.fn<() => Promise<OrphanClaude[]>>();
const takeover = vi.fn<(o: OrphanClaude, d: TakeoverDeps) => Promise<TakeoverResult>>();
// Probe used by claudeConfigDirsInUse (snapshot + readProcEnv). Empty by default.
const probeSnapshot = vi.fn<() => Promise<ProcRow[]>>(async () => []);
const probeReadProcEnv = vi.fn<(pid: number) => Promise<string>>(async () => "");
vi.mock("../../src/core/takeover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/takeover.js")>();
  return {
    ...actual,
    createTakeoverProbe: () =>
      ({ snapshot: probeSnapshot, readProcEnv: probeReadProcEnv }) as never,
    listOrphans: (...a: unknown[]) => listOrphans(...(a as [])),
    takeover: (...a: unknown[]) => takeover(...(a as Parameters<typeof takeover>)),
  };
});

const copyToClipboard = vi.fn(async () => {});
vi.mock("../../src/core/platform/clipboard.js", () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...(a as [])),
}));

const getPathBySession = vi.fn<(s: string) => string | null>(() => null);
const setPathForSession = vi.fn();
vi.mock("../../src/core/sessionPathMap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/sessionPathMap.js")>();
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
} = await import("../../src/core/takeover-service.js");

const ORPHAN: OrphanClaude = {
  pid: 42,
  cwd: "/home/u/proj",
  configRoot: "/home/u/.claude",
  sessionId: "sess-1",
  startCommand: "claude --resume sess-1",
};

beforeEach(() => {
  listOrphans.mockReset();
  takeover.mockReset();
  copyToClipboard.mockClear();
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

  it("maps other failures to the generic failed message", () => {
    const out = composeAdoptOutcome(
      { ok: false, sessionName: "tcb-x", resumed: false, reason: "claude_did_not_start" },
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
  it("delegates to listOrphans", async () => {
    listOrphans.mockResolvedValue([ORPHAN]);
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
      ...over,
    } as unknown as TmuxBridge;
    const configResolver = {
      isClaudeRunning: vi.fn(async () => resolverRunning),
    } as unknown as ConfigResolver;
    return {
      bridge,
      configResolver,
      projectSessionPrefix: "tcb-",
      warmupMs: 0,
    };
  }

  it("returns null when the tapped pid is no longer in the (re-scanned) orphan list", async () => {
    listOrphans.mockResolvedValue([{ ...ORPHAN, pid: 99 }]);
    expect(await adoptOrphan(42, ctx())).toBeNull();
    expect(takeover).not.toHaveBeenCalled();
  });

  it("wires the bridge/resolver into takeover and returns its result", async () => {
    listOrphans.mockResolvedValue([ORPHAN]);
    const result: TakeoverResult = { ok: true, sessionName: "tcb-proj", resumed: true };
    takeover.mockResolvedValue(result);
    expect(await adoptOrphan(42, ctx())).toBe(result);
    expect(takeover).toHaveBeenCalledWith(
      ORPHAN,
      expect.objectContaining({
        isTargetBusy: expect.any(Function),
        ensureSession: expect.any(Function),
        startInSession: expect.any(Function),
        isClaudeRunning: expect.any(Function),
      }),
    );
  });

  it("isTargetBusy: false when no session exists", async () => {
    listOrphans.mockResolvedValue([ORPHAN]);
    const c = ctx({ hasSession: vi.fn(async () => false) });
    takeover.mockImplementation(async (_o, d) => {
      expect(await d.isTargetBusy("/home/u/proj")).toBe(false);
      return { ok: true, sessionName: "s", resumed: false };
    });
    await adoptOrphan(42, c);
  });

  it("isTargetBusy: true when the existing session has a non-shell foreground", async () => {
    listOrphans.mockResolvedValue([ORPHAN]);
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
    listOrphans.mockResolvedValue([ORPHAN]);
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
    listOrphans.mockResolvedValue([ORPHAN]);
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
    listOrphans.mockResolvedValue([ORPHAN]);
    const sendKeys = vi.fn(async () => {});
    const c = ctx({ sendKeys }, false);
    takeover.mockImplementation(async (_o, d) => {
      await d.startInSession("tcb-x", "claude --resume sess-1");
      expect(sendKeys).toHaveBeenCalledWith("claude --resume sess-1", "tcb-x");
      expect(await d.isClaudeRunning("tcb-x")).toBe(false);
      return { ok: false, sessionName: "tcb-x", resumed: false, reason: "claude_did_not_start" };
    });
    await adoptOrphan(42, c);
  });

  it("rejects a concurrent adopt of the same pid (in-flight guard returns null)", async () => {
    listOrphans.mockResolvedValue([ORPHAN]);
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
    listOrphans.mockResolvedValue([]);
    expect(await adoptOrphan(42, ctx())).toBeNull();
    expect(listOrphans).toHaveBeenCalledTimes(2); // first + the post-release retry
  });
});
