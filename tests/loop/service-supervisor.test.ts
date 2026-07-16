import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopBacklogStore } from "../../src/core/loop/backlog.js";
import type { LoopRunCommandInvocation } from "../../src/core/loop/run.js";
import { LoopSchedulerStore } from "../../src/core/loop/scheduler.js";
import { runLoopServiceTickAsync, startLoopEngineering } from "../../src/core/loop/service.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

function writeLoopConfig(input: { runner?: string; projectPath: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-"));
  const file = join(dir, "loop.yml");
  writeFileSync(
    file,
    `
projects:
  - id: hub
    name: Hub
    path: ${input.projectPath}
    agent: codex
    schedule: "*/5 * * * *"
${input.runner ?? ""}
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: [tests]
`,
  );
  return file;
}

function supervisorSummaryPath(stateDir: string, projectId: string): string {
  const projectReportDir = join(stateDir, "loop-runs", projectId);
  const [runId] = readdirSync(projectReportDir);
  if (runId === undefined) throw new Error(`no supervisor report found for ${projectId}`);
  return join(projectReportDir, runId, "supervisor-summary.json");
}

function finalMarkerFromPrompt(prompt: string): string {
  const marker = prompt.match(/\[LOOP_SUPERVISOR_DONE:[^\]]+\]/)?.[0];
  if (marker === undefined) throw new Error("prompt did not include a final marker");
  return marker;
}

describe("runLoopServiceTickAsync supervised routing", () => {
  it("dispatches agent-supervised projects to the supervisor runner without running system commands", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const dispatched: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => {
        expect(request.session).toBe("tmux_proj_loop-supervisor");
        expect(request.signal.aborted).toBe(false);
        dispatched.push(request.prompt);
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("Loop Supervisor");
    expect(dispatched[0]).toContain('"projectId": "hub"');
    expect(readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8")).toContain(
      '"status": "completed"',
    );
  });

  it("keeps system projects on the system runner", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({ projectPath: projectDir });
    const invocations: LoopRunCommandInvocation[] = [];
    const runSupervisorTask = vi.fn(async () => ({
      status: 0,
      stdout: "",
      stderr: "",
    }));

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        invocations.push(invocation);
        return { status: 0, stdout: JSON.stringify({ findings: [] }), stderr: "" };
      },
      runSupervisorTask,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
    expect(invocations.map((invocation) => invocation.kind)).toEqual(["assessment"]);
    expect(runSupervisorTask).not.toHaveBeenCalled();
  });

  it("counts supervised invalid output as failed and writes the supervisor report", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async () => ({
        status: 0,
        stdout: "done without final marker",
        stderr: "",
      }),
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 1 });
    expect(readFileSync(supervisorSummaryPath(process.env.TCB_STATE_DIR, "hub"), "utf8")).toContain(
      '"status": "invalid-output"',
    );
  });

  it("retries the same scheduled fire when the supervisor session is not live", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const dispatch = vi.fn(async () => ({
      status: 1,
      stdout: "",
      stderr: 'no live loop supervisor session "tmux_proj_loop-supervisor"',
    }));

    const first = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });
    const second = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(first).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(second).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not restore a retryable failure over a newer scheduler anchor", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });
    const schedulerStore = new LoopSchedulerStore();
    const nextAnchor = Date.parse("2026-07-16T10:15:00Z");
    const dispatch = vi.fn(async () => {
      schedulerStore.setLastFired("hub", nextAnchor);
      return {
        status: 1,
        stdout: "",
        stderr: 'no live loop supervisor session "tmux_proj_loop-supervisor"',
      };
    });

    await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });
    const second = await runLoopServiceTickAsync({
      configFile: file,
      now: nextAnchor,
      schedulerStore,
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: dispatch,
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(second).toMatchObject({ due: 0, ran: 0, failed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("records supervisor follow-ups in the loop backlog", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = writeLoopConfig({
      projectPath: projectDir,
      runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 1000"].join("\n"),
    });

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("system runner should not run");
      },
      runSupervisorTask: async (request) => {
        const marker = finalMarkerFromPrompt(request.prompt);
        return {
          status: 0,
          stdout: `${marker}\n{"status":"completed","projectId":"hub","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":["Review supervisor logs weekly"]}`,
          stderr: "",
        };
      },
      supervisorSessionName: "tmux_proj_loop-supervisor",
    });

    expect(result).toMatchObject({ failed: 0 });
    expect(new LoopBacklogStore().list()).toEqual([
      expect.objectContaining({
        projectId: "hub",
        text: "Review supervisor logs weekly",
      }),
    ]);
  });

  it("does not overlap managed ticks while a supervisor run is still in flight", async () => {
    vi.useFakeTimers();
    try {
      process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-supervisor-state-"));
      const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
      const file = writeLoopConfig({
        projectPath: projectDir,
        runner: ["    runner:", "      kind: agent-supervised", "      timeoutMs: 60000"].join(
          "\n",
        ),
      });
      vi.setSystemTime(new Date("2026-07-16T10:10:00Z"));
      const enqueue = vi.fn(() => "queued" as const);
      const stop = startLoopEngineering(
        {
          config: {
            projectSessionPrefix: "tmux_proj_",
            maxWaitDoneTotalMs: 60_000,
          },
          bridge: {
            hasSession: vi.fn(async () => true),
          },
          queue: {
            enqueue,
            cancelQueued: vi.fn(() => false),
            loadPersisted: vi.fn(() => []),
            keepPersistedCarryover: vi.fn(),
          },
        } as never,
        { configFile: file, tickMs: 1000 },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(enqueue).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(enqueue).toHaveBeenCalledTimes(1);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
