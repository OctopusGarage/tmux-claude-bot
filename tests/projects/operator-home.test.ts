import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  it("seeds and refreshes only the managed policy block without clobbering custom content", () => {
    const dir = mkdtempSync(join(tmpdir(), "op-"));
    provisionOperatorHome(dir);
    const md = join(dir, "CLAUDE.md");
    expect(existsSync(md)).toBe(true);
    expect(readFileSync(md, "utf8")).toContain("operator");
    writeFileSync(md, "EDITED\n");
    provisionOperatorHome(dir);
    const refreshed = readFileSync(md, "utf8");
    expect(refreshed).toContain("EDITED");
    expect(refreshed).toContain("TCB_MANAGED_OPERATOR_POLICY_START");
    expect(refreshed).toContain("tcb.observer.status");
    provisionOperatorHome(dir);
    expect(readFileSync(md, "utf8").match(/TCB_MANAGED_OPERATOR_POLICY_START/g)).toHaveLength(1);
  });

  it("creates the directory when it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "op-base-"));
    const dir = join(base, "nested", "home");
    provisionOperatorHome(dir);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });

  it("replaces an untouched legacy generated policy instead of duplicating it", () => {
    const dir = mkdtempSync(join(tmpdir(), "op-legacy-"));
    const md = join(dir, "CLAUDE.md");
    writeFileSync(
      md,
      `# Home Operator

You are the **operator** for tmux-claude-bot. The user talks to you in chat (Telegram/
Lark); you manage their coding projects/agents on their behalf using the \`tcb\` CLI and
the Home Operator skill when available. You do NOT write code yourself -
you open projects, dispatch work, and report status.

This directory is the persistent working home for the Home Operator session. It
is not a product repository, target project, or WorkOrder worker directory.

## Recipes
- Open / switch a project: \`tcb open <name>\` (or \`tcb projects\` to list).
- Dispatch a task to a project's agent: \`tcb send <name> "<task>"\` (waits for the reply).
  For long tasks use \`tcb send <name> "<task>" --no-wait\` then \`tcb peek <name>\` to report.
- Status: \`tcb dashboard\` (all sessions), \`tcb peek <name>\` (one pane).
- Delegate clarified current work: \`tcb autopilot <name> [requirement]\`.
- Fleet control: \`tcb control <name> <esc|enter|restart|…>\`, \`tcb open\`, autopilot/batch.

## House rules
- **Restate and confirm before destructive actions** (removing a project, killing/
  restarting a session, any \`rm\`/destructive shell): say what you're about to do and
  wait for the user's "yes".
- Reply **concisely** — this is a chat surface.
- You drive OTHER sessions; never send to yourself.
- Do not edit files in target projects directly from this directory. Delegate
  code-changing work through the bot's project sessions, Autopilot, Loop
  Supervisor, or WorkOrder path.
`,
    );

    provisionOperatorHome(dir);

    const migrated = readFileSync(md, "utf8");
    expect(migrated.match(/TCB_MANAGED_OPERATOR_POLICY_START/g)).toHaveLength(1);
    expect(migrated).not.toContain("- Status: `tcb dashboard` (all sessions)");
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

  // performStart asserts the launcher binary is on PATH (assertClaudeBinaryAccessible).
  // CI runners have neither `claude` nor `codex` installed, so without this the start
  // step throws (swallowed by startOperator) and agent.start is never reached. Put
  // executable stubs on PATH so the real start path runs hermetically everywhere.
  let binDir: string;
  let origPath: string | undefined;
  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), "op-bin-"));
    for (const b of ["claude", "codex"]) {
      const p = join(binDir, b);
      writeFileSync(p, "#!/bin/sh\n");
      chmodSync(p, 0o755);
    }
    origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  });
  afterAll(() => {
    process.env.PATH = origPath;
  });

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
