import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createConfigResolver,
  createExecProbe,
  findClaudePid,
  parseApiInfo,
  parseClaudeConfigDir,
  type ResolverProbe,
} from "../src/core/claude-config-resolver.js";
import { selectIntrospector } from "../src/core/platform/introspector.js";

describe("parseApiInfo", () => {
  it("reports api mode + base url when an auth token is set (and never the token)", () => {
    const env =
      "claude --flag ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_AUTH_TOKEN=sk-secret PWD=/y";
    const info = parseApiInfo(env);
    expect(info).toEqual({ baseUrl: "https://api.minimaxi.com/anthropic", mode: "api" });
    expect(JSON.stringify(info)).not.toContain("sk-secret");
  });

  it("reports api mode for ANTHROPIC_API_KEY", () => {
    expect(parseApiInfo("claude ANTHROPIC_API_KEY=sk-x").mode).toBe("api");
  });

  it("reports subscription mode (no key) with null base url by default", () => {
    expect(parseApiInfo("claude --dangerously-skip-permissions")).toEqual({
      baseUrl: null,
      mode: "subscription",
    });
  });
});

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

describe("resolveConfigRoot when the pane can't be queried (tmux gone)", () => {
  it("keeps the last known root once one was resolved", async () => {
    let paneGone = false;
    let alive = true;
    const r = createConfigResolver(
      fakeProbe({
        panePid: async () => (paneGone ? null : 100),
        isAlive: async () => alive,
      }),
      OPTS,
    );
    expect(await r.resolveConfigRoot("s")).toBe("/root-A");
    paneGone = true;
    alive = false; // cheap path misses → re-scan → pane unqueryable
    expect(await r.resolveConfigRoot("s")).toBe("/root-A"); // last known, not default
  });

  it("falls back to the default root when nothing was ever resolved", async () => {
    const r = createConfigResolver(fakeProbe({ panePid: async () => null }), OPTS);
    expect(await r.resolveConfigRoot("s")).toBe("/home/.claude");
  });
});

describe("createExecProbe composition", () => {
  it("delegates snapshot/readProcEnv to the injected introspector", async () => {
    const intro = {
      snapshot: async () => [{ pid: 1, ppid: 0, command: "init" }],
      readProcEnv: async (pid: number) => `PID=${pid} CLAUDE_CONFIG_DIR=/tmp/cfg`,
      listOpenFiles: async () => [],
      cwdOf: async () => null,
    };
    const probe = createExecProbe(intro);
    expect(await probe.snapshot()).toEqual([{ pid: 1, ppid: 0, command: "init" }]);
    expect(await probe.readProcEnv(42)).toContain("CLAUDE_CONFIG_DIR=/tmp/cfg");
    expect(typeof probe.now()).toBe("number");
  });

  it("defaults to the platform-selected introspector", () => {
    expect(selectIntrospector()).toBeDefined();
    expect(createExecProbe()).toHaveProperty("snapshot");
  });
});

describe("createExecProbe (real ps / tmux / kill smoke tests)", () => {
  it("isAlive: true for our own pid, false for a nonexistent pid", async () => {
    const probe = createExecProbe();
    expect(await probe.isAlive(process.pid)).toBe(true);
    // PID far above any real allocation on macOS/Linux test machines.
    expect(await probe.isAlive(2 ** 22 + 12345)).toBe(false);
  });

  it("snapshot: parses real ps output and includes this process", async () => {
    const probe = createExecProbe();
    const rows = await probe.snapshot();
    const self = rows.find((r) => r.pid === process.pid);
    expect(self).toBeDefined();
    expect(self?.ppid).toBeGreaterThan(0);
    expect(self?.command).toContain("node");
  });

  it("readProcEnv: returns the command line of a live pid", async () => {
    const probe = createExecProbe();
    expect(await probe.readProcEnv(process.pid)).toContain("node");
  });

  it("panePid: null for a session that doesn't exist (or tmux missing)", async () => {
    const probe = createExecProbe();
    expect(await probe.panePid("tcb-test-no-such-session-xyz")).toBeNull();
  });
});
