import { describe, expect, it } from "vitest";
import type { ProcRow } from "../src/core/agents/agent-config-resolver.js";
import { isCodexProcess } from "../src/core/agents/codex/codex-process.js";
import { listCodexOrphans } from "../src/core/agents/codex/codex-takeover.js";
import type { TakeoverProbe } from "../src/core/agents/takeover.js";
import { buildCodexResumeCommand, findOrphans } from "../src/core/agents/takeover.js";

// ---------------------------------------------------------------------------
// findOrphans (codex predicate)
// ---------------------------------------------------------------------------

describe("findOrphans (codex predicate)", () => {
  // tmux server (1) -> pane shell (10) -> codex (11)   [in tmux]
  // login shell (20) -> codex (21)                     [orphan]
  // editor (30) referencing codex in args              [ignored]
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, command: "-zsh" },
    { pid: 11, ppid: 10, command: "codex exec --yolo" },
    { pid: 20, ppid: 1, command: "login -pf user" },
    { pid: 21, ppid: 20, command: "/usr/local/bin/codex" },
    { pid: 30, ppid: 1, command: "vim codex.ts" },
  ];

  it("returns codex pids not reachable from any tmux pane pid", () => {
    expect(findOrphans(rows, [10], isCodexProcess)).toEqual([21]);
  });

  it("treats every codex as orphan when there are no tmux panes", () => {
    expect(findOrphans(rows, [], isCodexProcess)).toEqual([11, 21]);
  });

  it("returns nothing when both codexes live under panes", () => {
    expect(findOrphans(rows, [10, 20], isCodexProcess)).toEqual([]);
  });

  it("matches a codex-<flavor> wrapper binary as orphan", () => {
    const flavorRows: ProcRow[] = [{ pid: 42, ppid: 1, command: "codex-stella exec" }];
    expect(findOrphans(flavorRows, [], isCodexProcess)).toEqual([42]);
  });

  it("does not treat a claude process as a codex orphan", () => {
    const mixed: ProcRow[] = [
      { pid: 50, ppid: 1, command: "claude --resume abc" },
      { pid: 51, ppid: 1, command: "codex" },
    ];
    expect(findOrphans(mixed, [], isCodexProcess)).toEqual([51]);
  });
});

// ---------------------------------------------------------------------------
// buildCodexResumeCommand
// ---------------------------------------------------------------------------

describe("buildCodexResumeCommand", () => {
  const DEFAULT_ROOT = `${process.env.HOME ?? "/home/u"}/.codex`;

  it("returns bare launcher when no sessionId", () => {
    expect(
      buildCodexResumeCommand({
        aliasName: null,
        configRoot: DEFAULT_ROOT,
        sessionId: null,
        origCmd: "codex",
      }),
    ).toBe("codex");
    expect(
      buildCodexResumeCommand({
        aliasName: "codex-stella",
        configRoot: null,
        sessionId: null,
        origCmd: "codex-stella exec",
      }),
    ).toBe("codex-stella");
  });

  it("appends resume <id> when sessionId is provided", () => {
    expect(
      buildCodexResumeCommand({
        aliasName: null,
        configRoot: DEFAULT_ROOT,
        sessionId: "uuid-1",
        origCmd: "codex",
      }),
    ).toBe("codex resume uuid-1");
    expect(
      buildCodexResumeCommand({
        aliasName: "codex-farmer",
        configRoot: null,
        sessionId: "uuid-2",
        origCmd: "codex-farmer",
      }),
    ).toBe("codex-farmer resume uuid-2");
  });

  it("prefixes CODEX_HOME for a non-default config root (non-alias fallback)", () => {
    expect(
      buildCodexResumeCommand({
        aliasName: null,
        configRoot: "/home/me/.codex-stella",
        sessionId: "uuid-3",
        origCmd: "codex",
      }),
    ).toBe("CODEX_HOME=/home/me/.codex-stella codex resume uuid-3");
  });

  it("does NOT prefix CODEX_HOME for the default root", () => {
    expect(
      buildCodexResumeCommand({
        aliasName: null,
        configRoot: DEFAULT_ROOT,
        sessionId: null,
        origCmd: "codex",
      }),
    ).toBe("codex");
  });

  it("carries over --yolo only when the original command had it (never adds it)", () => {
    expect(
      buildCodexResumeCommand({
        aliasName: null,
        configRoot: DEFAULT_ROOT,
        sessionId: "uuid-4",
        origCmd: "codex --yolo",
      }),
    ).toBe("codex --yolo resume uuid-4");
    // No yolo in the original → none in the reconstructed command.
    expect(
      buildCodexResumeCommand({
        aliasName: null,
        configRoot: DEFAULT_ROOT,
        sessionId: "uuid-4",
        origCmd: "codex",
      }),
    ).toBe("codex resume uuid-4");
  });

  it("does not double up env/yolo when an alias matched (alias carries them)", () => {
    expect(
      buildCodexResumeCommand({
        aliasName: "codex-stella",
        configRoot: "/home/me/.codex-stella",
        sessionId: "uuid-5",
        origCmd: "codex --yolo",
      }),
    ).toBe("codex-stella resume uuid-5");
  });
});

// ---------------------------------------------------------------------------
// listCodexOrphans
// ---------------------------------------------------------------------------

function fakeProbe(over: Partial<TakeoverProbe>): TakeoverProbe {
  return {
    snapshot: async () => [],
    tmuxPanePids: async () => [],
    cwdOf: async () => "/proj",
    openSessionFile: async () => null,
    readProcEnv: async () => "",
    readShellRc: async () => "",
    ttyOf: async () => null,
    resetTerminal: async () => {},
    isAlive: async () => false,
    signal: () => {},
    sleep: async () => {},
    ...over,
  };
}

describe("listCodexOrphans", () => {
  it("bails (empty) when tmux can't be queried (panePids null)", async () => {
    const probe = fakeProbe({
      snapshot: async () => [{ pid: 9, ppid: 1, command: "codex" }] as ProcRow[],
      tmuxPanePids: async () => null,
    });
    expect(await listCodexOrphans(probe)).toEqual([]);
  });

  it("drops an orphan with no resolvable cwd", async () => {
    const probe = fakeProbe({
      snapshot: async () => [{ pid: 9, ppid: 1, command: "codex" }] as ProcRow[],
      tmuxPanePids: async () => [],
      cwdOf: async () => null,
    });
    expect(await listCodexOrphans(probe)).toEqual([]);
  });

  it("builds the correct OrphanAgent for a codex orphan", async () => {
    const home = process.env.HOME ?? "/home/u";
    const codexHome = `${home}/.codex-stella`;
    const sessionUuid = "019d3003-2649-7c40-a990-dc49ebb6ec3e";
    const probe = fakeProbe({
      snapshot: async () => [{ pid: 55, ppid: 1, command: "codex" }] as ProcRow[],
      tmuxPanePids: async () => [],
      cwdOf: async () => "/home/u/myproject",
      readProcEnv: async () => `CODEX_HOME=${codexHome}`,
      readShellRc: async () => `alias codex-stella="CODEX_HOME=~/.codex-stella codex"`,
      openSessionFile: async () => sessionUuid,
    });

    const orphans = await listCodexOrphans(probe);
    expect(orphans).toHaveLength(1);
    const o = orphans[0];
    expect(o?.pid).toBe(55);
    expect(o?.cwd).toBe("/home/u/myproject");
    expect(o?.configRoot).toBe(codexHome);
    expect(o?.sessionId).toBe(sessionUuid);
    expect(o?.startCommand).toBe(`codex-stella resume ${sessionUuid}`);
    expect(o?.agent).toBe("codex");
  });

  it("falls back to default ~/.codex when CODEX_HOME is absent", async () => {
    const home = process.env.HOME ?? "/home/u";
    const probe = fakeProbe({
      snapshot: async () => [{ pid: 7, ppid: 1, command: "codex" }] as ProcRow[],
      tmuxPanePids: async () => [],
      cwdOf: async () => "/home/u/proj",
      readProcEnv: async () => "",
      readShellRc: async () => "",
      openSessionFile: async () => null,
    });
    const orphans = await listCodexOrphans(probe);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.configRoot).toBe(`${home}/.codex`);
  }, 15_000);

  it("uses null sessionId and bare codex command when nothing is open and no rollout on disk", async () => {
    const probe = fakeProbe({
      snapshot: async () => [{ pid: 7, ppid: 1, command: "codex" }] as ProcRow[],
      tmuxPanePids: async () => [],
      cwdOf: async () => "/home/u/proj",
      readProcEnv: async () => "",
      readShellRc: async () => "",
      openSessionFile: async () => null,
    });
    const orphans = await listCodexOrphans(probe);
    expect(orphans[0]?.sessionId).toBeNull();
    expect(orphans[0]?.startCommand).toBe("codex");
  }, 15_000);

  it("does not list claude processes as codex orphans", async () => {
    const probe = fakeProbe({
      snapshot: async () =>
        [
          { pid: 8, ppid: 1, command: "claude --resume abc" },
          { pid: 9, ppid: 1, command: "codex" },
        ] as ProcRow[],
      tmuxPanePids: async () => [],
      cwdOf: async () => "/home/u/proj",
    });
    const orphans = await listCodexOrphans(probe);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.pid).toBe(9);
  }, 15_000);
});
