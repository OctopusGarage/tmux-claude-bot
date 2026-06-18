import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import {
  createConfigResolver,
  type ResolverProbe,
} from "../src/core/agents/agent-config-resolver.js";

function fakeProbe(overrides: Partial<ResolverProbe>): ResolverProbe {
  return {
    panePid: overrides.panePid ?? (async () => 100),
    snapshot:
      overrides.snapshot ??
      (async () => [{ pid: 200, ppid: 100, command: "/usr/local/bin/codex --yolo" }]),
    readProcEnv: overrides.readProcEnv ?? (async () => "codex"),
    listOpenFiles: overrides.listOpenFiles ?? (async () => []),
    isAlive: overrides.isAlive ?? (async () => true),
    now: overrides.now ?? (() => 1000),
  };
}

const OPTS = { defaultRoot: "/home/.claude", claudeBin: "/bin/claude", ttlMs: 60000 };

describe("isCodexRunning", () => {
  it("returns true when a codex process is in the pane tree", async () => {
    const r = createConfigResolver(fakeProbe({}), OPTS);
    expect(await r.isCodexRunning("s")).toBe(true);
  });

  it("returns false when no codex process is in the pane tree (just a shell)", async () => {
    const r = createConfigResolver(
      fakeProbe({ snapshot: async () => [{ pid: 200, ppid: 100, command: "-zsh" }] }),
      OPTS,
    );
    expect(await r.isCodexRunning("s")).toBe(false);
  });

  it("returns false when the pane pid can't be determined", async () => {
    const r = createConfigResolver(fakeProbe({ panePid: async () => null }), OPTS);
    expect(await r.isCodexRunning("s")).toBe(false);
  });

  it("matches a codex-<flavor> wrapper binary", async () => {
    const r = createConfigResolver(
      fakeProbe({
        snapshot: async () => [
          { pid: 200, ppid: 100, command: "/usr/local/bin/codex-farmer --yolo" },
        ],
      }),
      OPTS,
    );
    expect(await r.isCodexRunning("s")).toBe(true);
  });

  it("does not confuse a claude process with codex", async () => {
    const r = createConfigResolver(
      fakeProbe({
        snapshot: async () => [
          { pid: 200, ppid: 100, command: "/bin/claude --dangerously-skip-permissions" },
        ],
      }),
      OPTS,
    );
    expect(await r.isCodexRunning("s")).toBe(false);
  });

  it("coalesces the process-table dump across calls within the TTL window", async () => {
    // A /list_alive_projects render resolves many sessions back-to-back; the
    // whole-process-table dump must not be repeated per call.
    const snapshot = vi.fn(async () => [
      { pid: 200, ppid: 100, command: "/usr/local/bin/codex --yolo" },
    ]);
    const r = createConfigResolver(fakeProbe({ snapshot }), OPTS);
    await r.isCodexRunning("s");
    await r.isCodexRunning("s");
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("caches the detected codex like claude: a 2nd resolve uses the cheap path (no readProcEnv re-scan)", async () => {
    // Parity with the claude pid-cache: once the codex pid is known and still
    // alive within the TTL, resolveCodexHome / detectAgentKind reuse it without
    // re-reading the process env.
    const readProcEnv = vi.fn(async () => "codex CODEX_HOME=/home/u/.codex-stella");
    const r = createConfigResolver(fakeProbe({ readProcEnv }), OPTS);
    expect(await r.resolveCodexHome?.("s")).toBe("/home/u/.codex-stella");
    expect(await r.detectAgentKind?.("s")).toBe("codex");
    expect(await r.resolveCodexHome?.("s")).toBe("/home/u/.codex-stella");
    expect(readProcEnv).toHaveBeenCalledTimes(1); // home read once, then cached
  });

  it("isClaudeRunning stays unaffected (existing behavior preserved)", async () => {
    const r = createConfigResolver(
      fakeProbe({
        snapshot: async () => [{ pid: 200, ppid: 100, command: "/bin/claude --x" }],
      }),
      OPTS,
    );
    expect(await r.isClaudeRunning("s")).toBe(true);
    expect(await r.isCodexRunning("s")).toBe(false);
  });
});

describe("resolveLiveTranscript", () => {
  const rolloutPath =
    "/home/user/.codex/sessions/2026/03/27/rollout-2026-03-27T10-00-00-11111111-2222-3333-4444-555555555555.jsonl";

  it("returns the rollout the live codex pid has open", async () => {
    const r = createConfigResolver(
      fakeProbe({ listOpenFiles: async () => ["/dev/null", rolloutPath] }),
      OPTS,
    );
    expect(await r.resolveLiveTranscript?.("s")).toEqual({
      path: rolloutPath,
      sessionId: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("returns the transcript a live CLAUDE pid has open (same generic path)", async () => {
    const claudeTranscript =
      "/home/user/.claude/projects/-home-user-proj/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl";
    const r = createConfigResolver(
      fakeProbe({
        snapshot: async () => [{ pid: 200, ppid: 100, command: "/bin/claude --x" }],
        listOpenFiles: async () => ["/dev/null", claudeTranscript],
      }),
      OPTS,
    );
    expect(await r.resolveLiveTranscript?.("s")).toEqual({
      path: claudeTranscript,
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
  });

  it("returns null when no codex runs in the pane", async () => {
    const r = createConfigResolver(
      fakeProbe({ snapshot: async () => [{ pid: 200, ppid: 100, command: "-zsh" }] }),
      OPTS,
    );
    expect(await r.resolveLiveTranscript?.("s")).toBeNull();
  });

  it("returns null when the live codex holds no rollout open", async () => {
    const r = createConfigResolver(fakeProbe({ listOpenFiles: async () => ["/dev/null"] }), OPTS);
    expect(await r.resolveLiveTranscript?.("s")).toBeNull();
  });
});
