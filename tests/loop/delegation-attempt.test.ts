import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedMessage } from "../../src/core/command/queue.js";
import { MessageQueue } from "../../src/core/command/queue.js";
import { createLoopSupervisorTaskRunner } from "../../src/core/loop/agent-queue.js";
import {
  claimDelegationAttempt,
  prepareDelegationAttempt,
  readDelegationAttempt,
  settleDelegationAttempt,
} from "../../src/core/loop/delegation-attempt.js";
import {
  buildIterationCheckpointTemplate,
  iterationCheckpointPath,
} from "../../src/core/loop/iteration-checkpoint.js";
import {
  loopSupervisorControlRestore,
  restoredLoopSupervisorMessage,
  shouldDiscardRestoredLoopSupervisorMessage,
} from "../../src/core/loop/supervisor-work-restore.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalStateDir = process.env.TCB_STATE_DIR;
const dirs: string[] = [];
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tcb-attempt-"));
  dirs.push(dir);
  process.env.TCB_STATE_DIR = dir;
  const workOrder: LoopWorkOrder = {
    id: "attempt-run",
    projectId: "app",
    projectName: "App",
    projectPath: "/repo/app",
    scheduledAt: 1,
    agent: "codex",
    goal: "Finish the task",
    maxRounds: 3,
    targetScore: 90,
    runner: { kind: "agent-supervised", timeoutMs: 10000, requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "npm test" },
    execution: { agent: true },
    recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: true },
    task: {
      kind: "active-delegated-task",
      sourceSession: "project-app",
      requirement: "Finish",
      requireReview: true,
      requireTests: true,
      requireCoverageReview: true,
      allowAiEval: false,
    },
    requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:attempt-run]",
    finalSummaryPath: join(dir, "final.json"),
  };
  return { dir, workOrder };
}

describe("durable delegation attempts", () => {
  function prepare(f: ReturnType<typeof fixture>, id = "attempt-1") {
    const prepared = prepareDelegationAttempt({
      workOrder: f.workOrder,
      attemptId: id,
      supervisorSession: "isolated-worker",
      prompt: "Finish",
      now: 1,
    });
    if (prepared === undefined) throw new Error("expected attempt");
    return prepared;
  }
  function restoreRecord(f: ReturnType<typeof fixture>, attemptId: string): PersistedMessage {
    return {
      id: attemptId,
      text: "Finish",
      chatId: "loop-engineering",
      channel: "control",
      sessionName: "isolated-worker",
      action: "text",
      controlRestore: loopSupervisorControlRestore(f.workOrder, "isolated-worker", 1, attemptId),
    };
  }

  it("restores only a prepared attempt and claims it once across reconstructed messages", () => {
    const f = fixture();
    const prepared = prepare(f);
    const persisted = restoreRecord(f, prepared.attemptId);
    const one = restoredLoopSupervisorMessage(persisted);
    const two = restoredLoopSupervisorMessage(persisted);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(one?.started?.()).toBe(true);
    expect(two?.started?.()).toBe(false);
    expect(restoredLoopSupervisorMessage(persisted)).toBeNull();
    expect(shouldDiscardRestoredLoopSupervisorMessage(persisted)).toBe(false);
  });

  it("preserves immutable settlement and discards a settled attempt from replay", () => {
    const f = fixture();
    const prepared = prepare(f);
    expect(claimDelegationAttempt(f.workOrder, prepared, 2)).toBe(true);
    expect(
      settleDelegationAttempt(
        f.workOrder,
        prepared,
        { status: 0, stdout: "first result", stderr: "" },
        false,
        3,
      ),
    ).toBe(true);
    expect(
      settleDelegationAttempt(
        f.workOrder,
        prepared,
        { status: 1, stdout: "", stderr: "late failure" },
        true,
        4,
      ),
    ).toBe(false);
    const state = readDelegationAttempt(f.workOrder, "isolated-worker", prepared.attemptId);
    expect(state.phase).toBe("settled");
    if (state.phase === "settled") expect(state.settled.output).toBe("first result");
    expect(restoredLoopSupervisorMessage(restoreRecord(f, prepared.attemptId))).toBeNull();
    expect(shouldDiscardRestoredLoopSupervisorMessage(restoreRecord(f, prepared.attemptId))).toBe(
      true,
    );
  });

  it("does not discard prepared work because a summary from an earlier attempt exists", () => {
    const f = fixture();
    writeFileSync(
      join(f.dir, "final.json"),
      JSON.stringify({
        status: "completed",
        projectId: "app",
        actionsTaken: [],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      }),
    );
    const prepared = prepare(f);
    const persisted = restoreRecord(f, prepared.attemptId);
    expect(restoredLoopSupervisorMessage(persisted)).not.toBeNull();
    expect(shouldDiscardRestoredLoopSupervisorMessage(persisted)).toBe(false);
  });

  it("rejects corrupt, foreign and path-traversing attempt references", () => {
    const f = fixture();
    const prepared = prepare(f);
    expect(
      readDelegationAttempt(
        { ...f.workOrder, goal: "Another task" },
        "isolated-worker",
        prepared.attemptId,
      ).phase,
    ).toBe("invalid");
    expect(readDelegationAttempt(f.workOrder, "wrong-worker", prepared.attemptId).phase).toBe(
      "invalid",
    );
    expect(restoredLoopSupervisorMessage(restoreRecord(f, "../outside"))).toBeNull();
    writeFileSync(join(f.dir, "iteration-attempts", prepared.attemptId, "prepared.json"), "{");
    expect(restoredLoopSupervisorMessage(restoreRecord(f, prepared.attemptId))).toBeNull();
    expect(shouldDiscardRestoredLoopSupervisorMessage(restoreRecord(f, prepared.attemptId))).toBe(
      false,
    );
  });

  it("rejects changed persisted prompts and duplicate preparation", () => {
    const f = fixture();
    const prepared = prepare(f);
    expect(() => prepare(f)).toThrow();
    const persisted = restoreRecord(f, prepared.attemptId);
    expect(restoredLoopSupervisorMessage({ ...persisted, text: "Different task" })).toBeNull();
    expect(restoredLoopSupervisorMessage({ ...persisted, id: "another-id" })).toBeNull();
    expect(
      restoredLoopSupervisorMessage({ ...persisted, sessionName: "another-worker" }),
    ).toBeNull();
    expect(readDelegationAttempt(f.workOrder, "isolated-worker", prepared.attemptId).phase).toBe(
      "prepared",
    );
  });

  it("settles restored execution once despite a late rejection", () => {
    const f = fixture();
    const prepared = prepare(f);
    const restored = restoredLoopSupervisorMessage(restoreRecord(f, prepared.attemptId));
    expect(restored?.started?.()).toBe(true);
    restored?.resolve("partial progress");
    restored?.reject(new Error("late failure"));
    const state = readDelegationAttempt(f.workOrder, "isolated-worker", prepared.attemptId);
    expect(state.phase).toBe("settled");
    if (state.phase === "settled") {
      expect(state.settled.status).toBe(0);
      expect(state.settled.output).toBe("partial progress");
    }
  });

  it("records preparation and start before execution, then preserves the settled checkpoint", async () => {
    const f = fixture();
    const queue = new MessageQueue(10, join(f.dir, "queue.json"));
    let attemptId: unknown;
    queue.setHandler(async (message) => {
      attemptId = message.controlRestore?.attemptId;
      expect(attemptId).toBe(message.id);
      const base = join(f.dir, "iteration-attempts", String(attemptId));
      const prepared = JSON.parse(readFileSync(join(base, "prepared.json"), "utf8"));
      expect(prepared.workOrderId).toBe(f.workOrder.id);
      expect(prepared.supervisorSession).toBe("isolated-worker");
      expect(prepared.contractHash).toBe(
        buildIterationCheckpointTemplate(f.workOrder).contractHash,
      );
      expect(JSON.parse(readFileSync(join(base, "started.json"), "utf8")).attemptId).toBe(
        attemptId,
      );
      const checkpoint = buildIterationCheckpointTemplate(f.workOrder);
      writeFileSync(iterationCheckpointPath(f.workOrder) ?? "missing", JSON.stringify(checkpoint));
      message.resolve("partial progress");
    });
    const result = await createLoopSupervisorTaskRunner({
      queue,
      config: { projectSessionPrefix: "project-" },
      bridge: { hasSession: async () => true },
    })({
      session: "isolated-worker",
      prompt: "Finish the authorized task",
      signal: new AbortController().signal,
      workOrder: f.workOrder,
    });
    expect(result.status, result.stderr).toBe(0);
    const settled = JSON.parse(
      readFileSync(join(f.dir, "iteration-attempts", String(attemptId), "settled.json"), "utf8"),
    );
    expect(settled.status).toBe(0);
    expect(JSON.parse(settled.checkpoint).status).toBe("available");
  });

  it("does not use an old summary as the queue completion probe", async () => {
    const f = fixture();
    writeFileSync(
      join(f.dir, "final.json"),
      JSON.stringify({
        status: "completed",
        projectId: "app",
        actionsTaken: [],
        delegatedTasks: [],
        finalVerification: "passed",
        commits: [],
        followUps: [],
      }),
    );
    const queue = new MessageQueue(10, join(f.dir, "queue.json"));
    let oldSummaryWasDone: boolean | undefined;
    queue.setHandler(async (message) => {
      oldSummaryWasDone = message.doneProbe?.("still working");
      message.resolve("partial progress");
    });
    await createLoopSupervisorTaskRunner({
      queue,
      config: { projectSessionPrefix: "project-" },
      bridge: { hasSession: async () => true },
    })({
      session: "isolated-worker",
      prompt: "Finish the authorized task",
      signal: new AbortController().signal,
      workOrder: f.workOrder,
    });
    expect(oldSummaryWasDone).toBe(false);
  });
});
