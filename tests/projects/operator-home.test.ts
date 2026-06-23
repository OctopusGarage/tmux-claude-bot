import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import { allRunningSessions } from "../../src/core/agents/runningSessions.js";
import {
  operatorHomeDir,
  provisionOperatorHome,
  startOperator,
} from "../../src/core/projects/operator-home.js";
import { logger } from "../../src/shared/utils/logger.js";

describe("provisionOperatorHome", () => {
  it("seeds CLAUDE.md when absent and never clobbers", () => {
    const dir = mkdtempSync(join(tmpdir(), "op-"));
    provisionOperatorHome(dir);
    const md = join(dir, "CLAUDE.md");
    expect(existsSync(md)).toBe(true);
    expect(readFileSync(md, "utf8")).toContain("operator");
    writeFileSync(md, "EDITED");
    provisionOperatorHome(dir); // idempotent — must not clobber
    expect(readFileSync(md, "utf8")).toBe("EDITED");
  });

  it("creates the directory when it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "op-base-"));
    const dir = join(base, "nested", "home");
    provisionOperatorHome(dir);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });
});

describe("operatorHomeDir", () => {
  it("returns config.homeOperator.dir when set", () => {
    const cfg = {
      homeOperator: { dir: "/custom/dir", agent: "claude" as const, enabled: true },
      projectSessionPrefix: "tmux_proj_",
    };
    expect(operatorHomeDir(cfg as any)).toBe("/custom/dir");
  });

  it("returns a home subdir of the state dir when dir is empty", () => {
    const cfg = {
      homeOperator: { dir: "", agent: "claude" as const, enabled: true },
      projectSessionPrefix: "tmux_proj_",
    };
    const result = operatorHomeDir(cfg as any);
    // TCB_STATE_DIR is set in tests/setup.ts; result must be stateDir/home
    expect(result).toMatch(/home$/);
    expect(result).not.toBe("/custom/dir");
  });
});

describe("startOperator", () => {
  const makeDir = () => mkdtempSync(join(tmpdir(), "op-"));

  const makeDeps = (enabled: boolean, alive: boolean) => {
    const dir = makeDir();
    return {
      config: {
        homeOperator: { enabled, dir, agent: "claude" as const },
        projectSessionPrefix: "tmux_proj_",
        claudeStartCommand: "claude --dangerously-skip-permissions",
        startCommands: [
          {
            command: "claude --dangerously-skip-permissions",
            agent: "claude" as const,
            label: "claude",
          },
        ],
      },
      bridge: {
        isPaneAlive: vi.fn(async () => alive),
        createSession: vi.fn(async () => true),
      },
      agent: {
        checkIfRunning: vi.fn(async () => false),
        start: vi.fn(async () => undefined),
      },
      configResolver: { invalidate: vi.fn() },
    };
  };

  it("is a no-op when disabled", async () => {
    const d = makeDeps(false, false) as any;
    await startOperator(d);
    expect(d.bridge.createSession).not.toHaveBeenCalled();
    expect(d.agent.start).not.toHaveBeenCalled();
  });

  it("creates session and starts agent when enabled and session absent", async () => {
    const d = makeDeps(true, false) as any;
    await startOperator(d);
    expect(d.bridge.createSession).toHaveBeenCalledWith("tmux_proj_home", expect.any(String));
    expect(d.agent.start).toHaveBeenCalled();
    // The command passed to agent.start must include --dangerously-skip-permissions
    const [, launchCmd] = d.agent.start.mock.calls[0] as [string, string];
    expect(launchCmd).toContain("--dangerously-skip-permissions");
  });

  it("uses --yolo (not the claude flag) for a codex operator", async () => {
    const dir = makeDir();
    const d = {
      config: {
        homeOperator: { enabled: true, dir, agent: "codex" as const },
        projectSessionPrefix: "tmux_proj_",
        claudeStartCommand: "claude --dangerously-skip-permissions",
        startCommands: [{ command: "codex", agent: "codex" as const, label: "codex" }],
      },
      bridge: { isPaneAlive: vi.fn(async () => false), createSession: vi.fn(async () => true) },
      agent: { checkIfRunning: vi.fn(async () => false), start: vi.fn(async () => undefined) },
      configResolver: { invalidate: vi.fn() },
    } as any;
    await startOperator(d);
    const [, launchCmd] = d.agent.start.mock.calls[0] as [string, string];
    expect(launchCmd).toContain("--yolo");
    expect(launchCmd).not.toContain("--dangerously-skip-permissions");
  });

  it("skips createSession when session is already alive", async () => {
    const d = makeDeps(true, true) as any;
    await startOperator(d);
    expect(d.bridge.createSession).not.toHaveBeenCalled();
    // agent.checkIfRunning returns false → start is called
    expect(d.agent.start).toHaveBeenCalled();
  });

  it("seeds CLAUDE.md in the home dir", async () => {
    const d = makeDeps(true, false) as any;
    await startOperator(d);
    const md = join(d.config.homeOperator.dir, "CLAUDE.md");
    expect(existsSync(md)).toBe(true);
    expect(readFileSync(md, "utf8")).toContain("operator");
  });

  it("warns when agent=codex but no codex start command is configured", async () => {
    const dir = makeDir();
    const d = {
      config: {
        homeOperator: { enabled: true, dir, agent: "codex" as const },
        projectSessionPrefix: "tmux_proj_",
        claudeStartCommand: "claude --dangerously-skip-permissions",
        startCommands: [
          {
            command: "claude --dangerously-skip-permissions",
            agent: "claude" as const,
            label: "claude",
          },
        ],
      },
      bridge: {
        isPaneAlive: vi.fn(async () => false),
        createSession: vi.fn(async () => true),
      },
      agent: {
        checkIfRunning: vi.fn(async () => false),
        start: vi.fn(async () => undefined),
      },
      configResolver: { invalidate: vi.fn() },
    } as any;
    await startOperator(d);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("no codex start command configured"),
      expect.objectContaining({
        data: expect.objectContaining({ hint: expect.stringContaining("CODEX_START_COMMAND") }),
      }),
    );
  });

  it("does not leave the operator in the running-roster after start", async () => {
    const d = makeDeps(true, false) as any;
    await startOperator(d);
    expect(allRunningSessions()).not.toContain("tmux_proj_home");
  });
});
