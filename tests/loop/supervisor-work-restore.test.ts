import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedMessage } from "../../src/core/command/queue.js";
import { LoopBacklogStore } from "../../src/core/loop/backlog.js";
import { listLoopReports } from "../../src/core/loop/report.js";
import {
  loopSupervisorControlRestore,
  restoredLoopSupervisorMessage,
} from "../../src/core/loop/supervisor-work-restore.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

const workOrder = {
  id: "wo-restore",
  scheduledAt: 1_000,
  projectId: "hub",
  projectName: "Hub",
  projectPath: "/repo/hub",
  agent: "codex",
  goal: "Improve architecture.",
  maxRounds: 3,
  targetScore: 90,
  runner: { kind: "agent-supervised", timeoutMs: 1000, requireConfirmation: false },
  allowedActions: ["tests"],
  blockedActions: ["direct-model-api"],
  skills: { approved: [] },
  preflight: { commands: [], repair: { agent: false } },
  assessment: { command: "npm run assess" },
  execution: { agent: true },
  recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
  commitPolicy: { enabled: false, perRound: true },
  requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:wo-restore]",
} satisfies LoopWorkOrder;

function persisted(restore: PersistedMessage["controlRestore"]): PersistedMessage {
  return {
    id: "msg-1",
    text: "Run supervised work order",
    chatId: "loop-engineering",
    channel: "control",
    sessionName: "tmux_proj_loop-supervisor",
    action: "text",
    origin: "system",
    promptSource: "control",
    controlRestore: restore,
  };
}

describe("supervisor work restore", () => {
  it("builds the persisted restore metadata for queued supervisor work", () => {
    expect(loopSupervisorControlRestore(workOrder, "tmux_proj_loop-supervisor", 1_234)).toEqual({
      kind: "loop-supervisor",
      workOrder,
      supervisorSession: "tmux_proj_loop-supervisor",
      queuedAt: 1_234,
    });
  });

  it("returns null for control messages without valid supervisor restore metadata", () => {
    expect(restoredLoopSupervisorMessage(persisted({ kind: "other" }))).toBeNull();
  });

  it("completes restored supervisor work through reports and backlog", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-restore-module-"));
    const message = restoredLoopSupervisorMessage(
      persisted(loopSupervisorControlRestore(workOrder, "tmux_proj_loop-supervisor", 1_000)),
      { now: () => 2_000 },
    );

    expect(message).not.toBeNull();
    message?.resolve(
      `${workOrder.requiredFinalMarker}\n{"status":"completed","projectId":"hub","actionsTaken":["restored"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":["Review restored work"]}`,
    );

    expect(listLoopReports()).toEqual([
      expect.objectContaining({
        runId: "wo-restore",
        projectId: "hub",
        status: "passed",
        startedAt: 1_000,
        endedAt: 2_000,
      }),
    ]);
    expect(new LoopBacklogStore().list()).toEqual([
      expect.objectContaining({
        projectId: "hub",
        text: "Review restored work",
      }),
    ]);
    const gatePath = join(
      process.env.TCB_STATE_DIR,
      "loop-runs",
      "hub",
      "wo-restore",
      "system-gate.json",
    );
    expect(existsSync(gatePath)).toBe(true);
    expect(JSON.parse(readFileSync(gatePath, "utf8"))).toEqual(
      expect.objectContaining({
        workOrderId: "wo-restore",
        projectId: "hub",
        resultStatus: "completed",
        accepted: true,
        evidence: expect.arrayContaining(["no mutating git or PR gate required"]),
        failures: [],
      }),
    );
  });
});
