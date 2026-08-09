import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopBacklogStore } from "../../src/core/loop/backlog.js";
import { listLoopReports } from "../../src/core/loop/report.js";
import type { LoopRunCommandInvocation } from "../../src/core/loop/run.js";
import { LoopSchedulerStore } from "../../src/core/loop/scheduler.js";
import { runLoopServiceTick, runLoopServiceTickAsync } from "../../src/core/loop/service.js";
import { createResourceGuardianStore } from "../../src/core/resource-guardian/store.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("runLoopServiceTick", () => {
  it("defers a due system target synchronously before creating durable execution state", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(
      join(tmpdir(), "tcb-loop-system-resource-gated-state-"),
    );
    createResourceGuardianStore({ stateDir: process.env.TCB_STATE_DIR }).writeCurrent({
      circuit: {
        schemaVersion: 1,
        pressure: "critical",
        incidentId: "incident-resource-closed",
        admission: "background-closed",
        reason: "critical host pressure",
        changedAt: 1000,
        lastSampleAt: 1000,
        owner: "resource-guardian",
      },
      view: {
        enabled: true,
        mode: "protect",
        profile: "balanced",
        pressure: "critical",
        circuit: "background-closed",
        incidentId: "incident-resource-closed",
        reason: "critical host pressure",
        attribution: "unknown",
        latestSample: null,
        stableSince: null,
        sampling: {
          degraded: false,
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastError: null,
          notifiedPhase: null,
          overlapSkippedTicks: 0,
        },
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-system-resource-gated-"));
    const file = join(dir, "loop.yml");
    writeFileSync(
      file,
      `
projects:
  - id: hub
    name: Hub
    path: ${mkdtempSync(join(tmpdir(), "tcb-loop-system-resource-gated-project-"))}
    agent: codex
    schedule: "*/5 * * * *"
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
`,
    );
    const schedulerStore = new LoopSchedulerStore();
    const runCommand = vi.fn();
    const now = Date.parse("2026-07-16T10:10:00Z");

    const result = runLoopServiceTick({
      configFile: file,
      now,
      schedulerStore,
      runCommand,
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 0, failed: 0 });
    expect(runCommand).not.toHaveBeenCalled();
    expect(schedulerStore.getLastFired()).toEqual({});
    expect(new DailyTaskLedger().listAll()).toEqual([]);
  });

  it("runs due projects, writes reports, records backlog suggestions, and persists fire anchors", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-state-"));
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-service-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = join(dir, "loop.yml");
    writeFileSync(
      file,
      `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    schedule: "*/5 * * * *"
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    assessment:
      command: npm run assess
    eval:
      command: npm run loop-eval
      minScore: 95
`,
    );
    const invocations: LoopRunCommandInvocation[] = [];

    const result = runLoopServiceTick({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        invocations.push(invocation);
        return {
          status: 0,
          stdout:
            invocation.kind === "eval"
              ? JSON.stringify({
                  passed: true,
                  score: 96,
                  findings: [],
                  suggestedBotImprovements: ["Show loop service failures in logs."],
                })
              : "assessment-ok",
          stderr: "",
        };
      },
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
    expect(invocations.map((invocation) => invocation.kind)).toEqual(["assessment", "eval"]);
    expect(listLoopReports()).toEqual([expect.objectContaining({ projectId: "hub" })]);
    expect(new LoopBacklogStore().list()).toEqual([
      expect.objectContaining({ text: "Show loop service failures in logs." }),
    ]);
    const second = runLoopServiceTick({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: () => {
        throw new Error("should not run twice");
      },
    });
    expect(second.ran).toBe(0);
  });

  it("runs due agent-execution projects through an injected async adapter", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-state-"));
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-service-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = join(dir, "loop.yml");
    writeFileSync(
      file,
      `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    schedule: "*/5 * * * *"
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    execution:
      agent: true
    assessment:
      command: npm run assess
    allowedActions: [tests]
`,
    );
    const invocations: LoopRunCommandInvocation[] = [];
    const agentPrompts: string[] = [];

    const result = await runLoopServiceTickAsync({
      configFile: file,
      now: Date.parse("2026-07-16T10:10:00Z"),
      schedulerStore: new LoopSchedulerStore(),
      runCommand: (invocation) => {
        invocations.push(invocation);
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              findings: [
                {
                  id: "f1",
                  title: "Add parser regression",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add a focused parser regression test.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
      runAgentTask: async (invocation) => {
        agentPrompts.push(invocation.prompt);
        return { status: 0, stdout: "agent done", stderr: "" };
      },
    });

    expect(result).toMatchObject({ checked: 1, due: 1, ran: 1, failed: 0 });
    expect(agentPrompts[0]).toContain("Add a focused parser regression test.");
    expect(invocations.map((invocation) => invocation.kind)).toEqual([
      "assessment",
      "verification",
    ]);
    expect(listLoopReports()).toEqual([expect.objectContaining({ projectId: "hub" })]);
  });

  it("does not advance the schedule anchor when a due project never completes a run", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-state-"));
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-service-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = join(dir, "loop.yml");
    writeFileSync(
      file,
      `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    schedule: "*/5 * * * *"
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    execution:
      agent: true
    assessment:
      command: npm run assess
    allowedActions: [tests]
`,
    );
    const schedulerStore = new LoopSchedulerStore();
    const now = Date.parse("2026-07-16T10:10:00Z");

    await expect(
      runLoopServiceTickAsync({
        configFile: file,
        now,
        schedulerStore,
        runCommand: (invocation) => {
          if (invocation.kind === "assessment") {
            return {
              status: 0,
              stdout: JSON.stringify({
                findings: [
                  {
                    id: "f1",
                    title: "Add parser regression",
                    action: "tests",
                    confidence: "high",
                    autofixSafety: "safe",
                    affectedFiles: ["tests/parser.test.ts"],
                    prompt: "Add a focused parser regression test.",
                    verificationCommands: ["npm test -- tests/parser.test.ts"],
                  },
                ],
              }),
              stderr: "",
            };
          }
          return { status: 0, stdout: "verified", stderr: "" };
        },
        runAgentTask: async () => {
          throw new Error("agent session disappeared before enqueue");
        },
      }),
    ).rejects.toThrow(/agent session disappeared/);

    expect(schedulerStore.getLastFired()).toEqual({});

    const retry = await runLoopServiceTickAsync({
      configFile: file,
      now,
      schedulerStore,
      runCommand: (invocation) => {
        if (invocation.kind === "assessment") {
          return { status: 0, stdout: JSON.stringify({ findings: [] }), stderr: "" };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
    });

    expect(retry).toMatchObject({ due: 1, ran: 1, failed: 0 });
    expect(schedulerStore.getLastFired()).toEqual({ hub: now });
  });

  it("does not advance the schedule anchor when agent dispatch fails before work can run", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-service-state-"));
    const dir = mkdtempSync(join(tmpdir(), "tcb-loop-service-"));
    const projectDir = mkdtempSync(join(tmpdir(), "tcb-loop-project-"));
    const file = join(dir, "loop.yml");
    writeFileSync(
      file,
      `
projects:
  - id: hub
    name: Hub
    path: ${projectDir}
    agent: codex
    schedule: "*/5 * * * *"
    goal: Improve core module clarity in small verified slices.
    maxRounds: 1
    targetScore: 90
    execution:
      agent: true
    recovery:
      agent: true
      maxAttempts: 1
    assessment:
      command: npm run assess
    allowedActions: [tests]
`,
    );
    const schedulerStore = new LoopSchedulerStore();
    const now = Date.parse("2026-07-16T10:10:00Z");

    const first = await runLoopServiceTickAsync({
      configFile: file,
      now,
      schedulerStore,
      runCommand: (invocation) => {
        if (invocation.kind === "assessment") {
          return {
            status: 0,
            stdout: JSON.stringify({
              findings: [
                {
                  id: "f1",
                  title: "Add parser regression",
                  action: "tests",
                  confidence: "high",
                  autofixSafety: "safe",
                  affectedFiles: ["tests/parser.test.ts"],
                  prompt: "Add a focused parser regression test.",
                  verificationCommands: ["npm test -- tests/parser.test.ts"],
                },
              ],
            }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
      runAgentTask: async () => ({
        status: 1,
        stdout: "",
        stderr: "Codex did not become ready in time",
      }),
    });
    const second = await runLoopServiceTickAsync({
      configFile: file,
      now,
      schedulerStore,
      runCommand: (invocation) => {
        if (invocation.kind === "assessment") {
          return { status: 0, stdout: JSON.stringify({ findings: [] }), stderr: "" };
        }
        return { status: 0, stdout: "verified", stderr: "" };
      },
    });

    expect(first).toMatchObject({ due: 1, ran: 1, failed: 1 });
    expect(second).toMatchObject({ due: 1, ran: 1, failed: 0 });
    expect(schedulerStore.getLastFired()).toEqual({ hub: now });
  });
});
