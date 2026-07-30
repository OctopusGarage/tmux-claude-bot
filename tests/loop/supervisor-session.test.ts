import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allRunningSessions, markSessionRunning } from "../../src/core/agents/runningSessions.js";
import type { HandlerDeps } from "../../src/core/deps.js";
import {
  isLoopSupervisorSession,
  loopSupervisorDir,
  loopSupervisorSessionName,
  provisionLoopSupervisorHome,
  startLoopSupervisor,
} from "../../src/core/loop/supervisor-session.js";
import { getPathBySession } from "../../src/core/projects/sessionPathMap.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("loop supervisor session", () => {
  it("uses a reserved project-family session name", () => {
    expect(loopSupervisorSessionName("tmux_proj_")).toBe("tmux_proj_loop-supervisor");
    expect(isLoopSupervisorSession("tmux_proj_loop-supervisor", "tmux_proj_")).toBe(true);
    expect(isLoopSupervisorSession("tmux_proj_home", "tmux_proj_")).toBe(false);
  });

  it("resolves custom and default supervisor directories", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-state-"));
    process.env.TCB_STATE_DIR = stateDir;

    expect(
      loopSupervisorDir({
        loopEngineering: {
          configFile: "",
          tickMs: 0,
          supervisor: { enabled: true, dir: "/custom/supervisor", agent: "codex" },
        },
      }),
    ).toBe("/custom/supervisor");
    expect(
      loopSupervisorDir({
        loopEngineering: {
          configFile: "",
          tickMs: 0,
          supervisor: { enabled: true, dir: "", agent: "codex" },
        },
      }),
    ).toBe(join(stateDir, "loop-supervisor"));

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("provisions supervisor instructions idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-"));
    try {
      provisionLoopSupervisorHome(dir);
      const firstAgents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      const firstClaude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      provisionLoopSupervisorHome(dir);
      const secondAgents = readFileSync(join(dir, "AGENTS.md"), "utf8");
      const secondClaude = readFileSync(join(dir, "CLAUDE.md"), "utf8");

      expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
      expect(firstAgents).toBe(secondAgents);
      expect(firstClaude).toBe(secondClaude);
      expect(firstAgents).toContain("Loop Supervisor");
      expect(firstAgents).toContain("Do not call model-provider APIs");
      expect(firstAgents).toContain("persistent working home");
      expect(firstAgents).toContain("Use the `tcb` CLI");
      expect(firstAgents).toContain("Do not silently ignore partial work");
      expect(firstAgents).toContain("required final marker");
      expect(firstClaude).toBe(firstAgents);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not start when disabled", async () => {
    const createSession = vi.fn(async () => true);
    const performStart = vi.fn(
      async (_deps: HandlerDeps, _session: string, _command?: string) => "started" as const,
    );
    const deps = {
      bridge: { createSession, isPaneAlive: vi.fn(async () => false) },
      config: {
        projectSessionPrefix: "tmux_proj_",
        loopEngineering: {
          configFile: "",
          tickMs: 0,
          supervisor: { enabled: false, dir: "", agent: "codex" as const },
        },
        startCommands: [{ agent: "codex" as const, command: "codex", label: "codex" }],
        claudeStartCommand: "claude",
      },
    };

    await startLoopSupervisor(deps as never, performStart);

    expect(createSession).not.toHaveBeenCalled();
    expect(performStart).not.toHaveBeenCalled();
  });

  it("starts the configured supervisor session and removes it from recovery", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const createSession = vi.fn(async () => true);
    const isPaneAlive = vi.fn(async () => false);
    const waitUntilReady = vi.fn(async () => {});
    const deps = {
      bridge: { createSession, isPaneAlive },
      agent: { waitUntilReady },
      config: {
        projectSessionPrefix: "tmux_proj_",
        loopEngineering: {
          configFile: "",
          tickMs: 0,
          supervisor: { enabled: true, dir: "", agent: "codex" as const },
        },
        startCommands: [{ agent: "codex" as const, command: "codex", label: "codex" }],
        claudeStartCommand: "claude",
      },
    };
    const performStart = vi.fn(
      async (_deps: HandlerDeps, _session: string, _command?: string) => "started" as const,
    );
    const session = "tmux_proj_loop-supervisor";
    markSessionRunning(session);

    await startLoopSupervisor(deps as never, performStart);

    const expectedDir = join(stateDir, "loop-supervisor");
    expect(createSession).toHaveBeenCalledWith(session, expectedDir);
    expect(performStart).toHaveBeenCalledWith(deps, session, expect.stringContaining("codex"));
    expect(waitUntilReady).toHaveBeenCalledWith(session);
    expect(performStart.mock.calls[0]?.[2]).toContain("--yolo");
    expect(getPathBySession(session)).toBe(expectedDir);
    expect(allRunningSessions()).not.toContain(session);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("skips createSession when the supervisor pane is already alive", async () => {
    const createSession = vi.fn(async () => true);
    const waitUntilReady = vi.fn(async () => {});
    const deps = {
      bridge: { createSession, isPaneAlive: vi.fn(async () => true) },
      agent: { waitUntilReady },
      config: {
        projectSessionPrefix: "tmux_proj_",
        loopEngineering: {
          configFile: "",
          tickMs: 0,
          supervisor: {
            enabled: true,
            dir: mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-")),
            agent: "claude" as const,
          },
        },
        startCommands: [
          {
            agent: "claude" as const,
            command: "claude --dangerously-skip-permissions",
            label: "claude",
          },
        ],
        claudeStartCommand: "claude --dangerously-skip-permissions",
      },
    };
    const performStart = vi.fn(
      async (_deps: HandlerDeps, _session: string, _command?: string) => "already-running" as const,
    );

    await startLoopSupervisor(deps as never, performStart);

    expect(createSession).not.toHaveBeenCalled();
    expect(waitUntilReady).toHaveBeenCalledWith("tmux_proj_loop-supervisor");
    expect(performStart.mock.calls[0]?.[2]).toContain("--dangerously-skip-permissions");
  });

  it("does not report ensured when the supervisor agent is not input-ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-supervisor-"));
    const createSession = vi.fn(async () => true);
    const deps = {
      bridge: {
        createSession,
        isPaneAlive: vi.fn(async () => true),
      },
      agent: {
        waitUntilReady: vi.fn(async () => {
          throw new Error("Codex did not become ready in time");
        }),
      },
      config: {
        projectSessionPrefix: "tmux_proj_",
        loopEngineering: {
          configFile: "",
          tickMs: 0,
          supervisor: { enabled: true, dir, agent: "codex" as const },
        },
        startCommands: [{ agent: "codex" as const, command: "codex", label: "codex" }],
        claudeStartCommand: "claude",
      },
    };
    const performStart = vi.fn(
      async (_deps: HandlerDeps, _session: string, _command?: string) => "already-running" as const,
    );

    await expect(startLoopSupervisor(deps as never, performStart)).resolves.toBe(false);

    expect(createSession).not.toHaveBeenCalled();
    expect(deps.agent.waitUntilReady).toHaveBeenCalledWith("tmux_proj_loop-supervisor");
    rmSync(dir, { recursive: true, force: true });
  });
});
