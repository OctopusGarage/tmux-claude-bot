import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createConfigResolver,
  findClaudePid,
  parseClaudeConfigDir,
  type ResolverProbe,
} from "../src/services/claude-config-resolver.js";

describe("parseClaudeConfigDir", () => {
  it("extracts CLAUDE_CONFIG_DIR from ps eww output", () => {
    const out =
      "/Users/x/.local/bin/claude --flag PATH=/a:/b CLAUDE_CONFIG_DIR=/Users/x/.claude-stella PWD=/y";
    expect(parseClaudeConfigDir(out)).toBe("/Users/x/.claude-stella");
  });

  it("returns null when the variable is absent (→ caller uses default ~/.claude)", () => {
    expect(parseClaudeConfigDir("/Users/x/.local/bin/claude PATH=/a:/b")).toBeNull();
  });
});

describe("findClaudePid", () => {
  const BIN = "/Users/x/.local/bin/claude";
  it("finds claude as a direct child of the pane pid", () => {
    const rows = [
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: `${BIN} --dangerously-skip-permissions` },
    ];
    expect(findClaudePid(rows, 100, BIN)).toBe(200);
  });

  it("finds claude as a deeper descendant", () => {
    const rows = [
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 150, ppid: 100, command: "node wrapper" },
      { pid: 200, ppid: 150, command: `${BIN} --x` },
    ];
    expect(findClaudePid(rows, 100, BIN)).toBe(200);
  });

  it("matches when the pane pid itself is claude", () => {
    const rows = [{ pid: 100, ppid: 1, command: `${BIN} --x` }];
    expect(findClaudePid(rows, 100, BIN)).toBe(100);
  });

  it("matches a bare `claude` invocation (e.g. via the claude-stella alias)", () => {
    // claude-stella runs `claude` (bare), so argv[0] is "claude", not the full
    // path the bot's CLAUDE_START_COMMAND uses. Must match by executable name.
    const rows = [
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: "claude --dangerously-skip-permissions --resume abc" },
    ];
    expect(findClaudePid(rows, 100, BIN)).toBe(200);
  });

  it("does not match an unrelated 'claude'-containing path", () => {
    const rows = [
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: "tail -f /var/log/claude-helper.log" },
    ];
    expect(findClaudePid(rows, 100, BIN)).toBeNull();
  });

  it("returns null when no claude runs under the pane (just a shell)", () => {
    const rows = [
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: "vim file" },
    ];
    expect(findClaudePid(rows, 100, BIN)).toBeNull();
  });
});

function fakeProbe(overrides: Partial<ResolverProbe> & { time?: { v: number } }): ResolverProbe {
  const t = overrides.time ?? { v: 1000 };
  return {
    panePid: overrides.panePid ?? (async () => 100),
    snapshot:
      overrides.snapshot ?? (async () => [{ pid: 200, ppid: 100, command: "/bin/claude --x" }]),
    readProcEnv: overrides.readProcEnv ?? (async () => "claude CLAUDE_CONFIG_DIR=/root-A"),
    isAlive: overrides.isAlive ?? (async () => true),
    now: overrides.now ?? (() => t.v),
  };
}

const OPTS = { defaultRoot: "/home/.claude", claudeBin: "/bin/claude", ttlMs: 60000 };

describe("createConfigResolver", () => {
  it("resolves and caches the config root from the live claude process", async () => {
    const readProcEnv = vi.fn(async () => "claude CLAUDE_CONFIG_DIR=/root-A");
    const snapshot = vi.fn(async () => [{ pid: 200, ppid: 100, command: "/bin/claude" }]);
    const r = createConfigResolver(fakeProbe({ readProcEnv, snapshot }), OPTS);
    expect(await r.resolveConfigRoot("s")).toBe("/root-A");
    // second call: cheap path — does NOT re-query the process
    expect(await r.resolveConfigRoot("s")).toBe("/root-A");
    expect(readProcEnv).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("re-resolves when the cached claude pid is no longer alive (restart)", async () => {
    let alive = true;
    const readProcEnv = vi.fn(async () => "x CLAUDE_CONFIG_DIR=/root-A");
    const r = createConfigResolver(fakeProbe({ readProcEnv, isAlive: async () => alive }), OPTS);
    await r.resolveConfigRoot("s");
    alive = false; // claude restarted → old pid dead
    await r.resolveConfigRoot("s");
    expect(readProcEnv).toHaveBeenCalledTimes(2);
  });

  it("re-resolves after invalidate() even if the pid is still alive (/clear /new)", async () => {
    const readProcEnv = vi.fn(async () => "x CLAUDE_CONFIG_DIR=/root-A");
    const r = createConfigResolver(fakeProbe({ readProcEnv }), OPTS);
    await r.resolveConfigRoot("s");
    r.invalidate("s");
    await r.resolveConfigRoot("s");
    expect(readProcEnv).toHaveBeenCalledTimes(2);
  });

  it("re-resolves once the TTL has expired", async () => {
    const time = { v: 1000 };
    const readProcEnv = vi.fn(async () => "x CLAUDE_CONFIG_DIR=/root-A");
    const r = createConfigResolver(fakeProbe({ readProcEnv, time }), OPTS);
    await r.resolveConfigRoot("s");
    time.v += 60001; // past TTL
    await r.resolveConfigRoot("s");
    expect(readProcEnv).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default root when no claude runs in the pane", async () => {
    const r = createConfigResolver(
      fakeProbe({ snapshot: async () => [{ pid: 200, ppid: 100, command: "-zsh" }] }),
      OPTS,
    );
    expect(await r.resolveConfigRoot("s")).toBe("/home/.claude");
  });

  it("uses the default root when CLAUDE_CONFIG_DIR is unset on the process", async () => {
    const r = createConfigResolver(
      fakeProbe({ readProcEnv: async () => "/bin/claude --x PATH=/a" }),
      OPTS,
    );
    expect(await r.resolveConfigRoot("s")).toBe("/home/.claude");
  });
});

describe("isClaudeRunning (shares the same process-tree scan)", () => {
  it("returns true when a claude process is in the pane tree", async () => {
    const r = createConfigResolver(fakeProbe({}), OPTS);
    expect(await r.isClaudeRunning("s")).toBe(true);
  });

  it("returns false when no claude runs in the pane", async () => {
    const r = createConfigResolver(
      fakeProbe({ snapshot: async () => [{ pid: 200, ppid: 100, command: "-zsh" }] }),
      OPTS,
    );
    expect(await r.isClaudeRunning("s")).toBe(false);
  });

  it("returns false when the pane pid can't be determined", async () => {
    const r = createConfigResolver(fakeProbe({ panePid: async () => null }), OPTS);
    expect(await r.isClaudeRunning("s")).toBe(false);
  });

  it("uses the cheap path: a previously-resolved live pid is reported running without re-scanning", async () => {
    const snapshot = vi.fn(async () => [{ pid: 200, ppid: 100, command: "/bin/claude" }]);
    const r = createConfigResolver(fakeProbe({ snapshot }), OPTS);
    await r.resolveConfigRoot("s"); // warms the cache with pid 200 (1 snapshot)
    expect(await r.isClaudeRunning("s")).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(1); // cheap path → no extra scan
  });
});
