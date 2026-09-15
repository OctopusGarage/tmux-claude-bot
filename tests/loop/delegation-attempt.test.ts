import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedMessage, QueuedMessage } from "../../src/core/command/queue.js";
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
import { runLoopSupervisedProjectAsync } from "../../src/core/loop/supervised-runner.js";
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

  async function childAttempt(action: "prepare" | "claim" | "cancel", payload: unknown) {
    const source = `
      import { prepareDelegationAttempt, claimDelegationAttempt, settleDelegationAttempt } from ${JSON.stringify(new URL("../../src/core/loop/delegation-attempt.ts", import.meta.url).href)};
      const input = JSON.parse(process.argv[1]);
      let ok = false;
      try {
        if (input.action === "prepare") ok = prepareDelegationAttempt(input.payload) !== undefined;
        else if (input.action === "claim") ok = claimDelegationAttempt(input.payload.workOrder, input.payload.prepared, 2);
        else ok = settleDelegationAttempt(input.payload.workOrder, input.payload.prepared, {status: 1, stdout: "", stderr: "cancelled before start"}, true, 2, false);
      } catch {}
      process.stdout.write(JSON.stringify({ok}));
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source, JSON.stringify({ action, payload })],
      { timeout: 15_000 },
    );
    return JSON.parse(result.stdout) as { ok: boolean };
  }

  it.each([false, true])(
    "allows one cross-process reservation (existing settled attempt: %s)",
    async (withPrevious) => {
      const f = fixture();
      if (withPrevious) {
        const first = prepare(f);
        settleDelegationAttempt(
          f.workOrder,
          first,
          { status: 1, stdout: "", stderr: "not queued" },
          false,
          2,
          false,
        );
      }
      const results = await Promise.all(
        ["worker-a", "worker-b"].map((id) =>
          childAttempt("prepare", {
            workOrder: f.workOrder,
            attemptId: id,
            supervisorSession: id,
            prompt: "Finish",
            now: 3,
          }),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const winner = results[0]?.ok ? "worker-a" : "worker-b";
      expect(readDelegationAttempt(f.workOrder, winner, winner).phase).toBe("prepared");
    },
  );

  it("makes cross-process start and pre-start cancellation mutually exclusive", async () => {
    const f = fixture();
    const prepared = prepare(f);
    const [claim, cancel] = await Promise.all([
      childAttempt("claim", { workOrder: f.workOrder, prepared }),
      childAttempt("cancel", { workOrder: f.workOrder, prepared }),
    ]);
    expect(Number(claim.ok) + Number(cancel.ok)).toBe(1);
    expect(readDelegationAttempt(f.workOrder, "isolated-worker", prepared.attemptId).phase).toBe(
      claim.ok ? "started" : "settled",
    );
  });

  it("fences different attempt IDs until the preceding transport settles", () => {
    const f = fixture();
    const first = prepare(f);
    expect(() => prepare(f, "attempt-2")).toThrow();
    expect(claimDelegationAttempt(f.workOrder, first, 2)).toBe(true);
    expect(() => prepare(f, "attempt-3")).toThrow();
    expect(
      settleDelegationAttempt(
        f.workOrder,
        first,
        { status: 0, stdout: "partial", stderr: "" },
        false,
        3,
        true,
      ),
    ).toBe(true);
    const next = prepare(f, "attempt-4");
    expect(claimDelegationAttempt(f.workOrder, next, 4)).toBe(true);
    expect(claimDelegationAttempt(f.workOrder, first, 5)).toBe(false);
    expect(
      settleDelegationAttempt(
        f.workOrder,
        first,
        { status: 1, stdout: "", stderr: "late" },
        false,
        5,
        true,
      ),
    ).toBe(false);
    expect(readDelegationAttempt(f.workOrder, "isolated-worker", next.attemptId).phase).toBe(
      "started",
    );
  });

  it("disables final-summary recovery when dispatch cannot acquire attempt ownership", async () => {
    const f = fixture();
    prepare(f);
    const enqueue = vi.fn(() => "queued" as const);
    const dispatch = createLoopSupervisorTaskRunner({
      config: { projectSessionPrefix: "project-" },
      bridge: { hasSession: async () => true },
      queue: { enqueue, cancelQueued: () => false },
    });
    const result = await runLoopSupervisedProjectAsync({
      workOrder: f.workOrder,
      supervisorSession: "isolated-worker",
      timeoutMs: 10000,
      dispatch,
    });
    expect(result.status).toBe("dispatch-failed");
    expect(result.finalSummaryRecovery).toBe("disabled");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not reset or enqueue a second invocation while another attempt owns the WorkOrder", async () => {
    const f = fixture();
    const queued: QueuedMessage[] = [];
    const runner = createLoopSupervisorTaskRunner({
      config: { projectSessionPrefix: "project-" },
      bridge: { hasSession: async () => true },
      queue: {
        enqueue: (message) => {
          queued.push(message);
          if (message.action !== "text") message.resolve("reset");
          return "queued" as const;
        },
        cancelQueued: () => false,
      },
    });
    const invocation = {
      session: "isolated-worker",
      prompt: "Finish",
      signal: new AbortController().signal,
      workOrder: f.workOrder,
    };
    const first = runner(invocation);
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    try {
      const second = await runner({ ...invocation, contextReset: "clear" });
      expect(second.status).toBe(1);
      expect(queued.map((message) => message.action)).toEqual(["text"]);
    } finally {
      queued[0]?.reject(new Error("test cleanup"));
      await first;
    }
  });

  it("rejects reuse of a settled ID without damaging the next reservation", () => {
    const f = fixture();
    const first = prepare(f);
    settleDelegationAttempt(
      f.workOrder,
      first,
      { status: 1, stdout: "", stderr: "not queued" },
      false,
      2,
      true,
    );
    expect(() => prepare(f)).toThrow();
    expect(() => prepare(f, "fresh-id")).not.toThrow();
  });

  it("does not bypass a crash between reserving an owner and preparing its record", () => {
    const f = fixture();
    const root = join(f.dir, "iteration-attempts");
    mkdirSync(root);
    writeFileSync(
      join(root, "first.json"),
      JSON.stringify({ attemptId: "interrupted", supervisorSession: "isolated-worker" }),
    );
    expect(() => prepare(f)).toThrow();
  });

  it("requires reconciliation for attempt history without ownership links", () => {
    const f = fixture();
    mkdirSync(join(f.dir, "iteration-attempts", "legacy-attempt"), { recursive: true });
    expect(() => prepare(f)).toThrow();
  });

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

  it("does not let an unclaimed restored callback settle another message's active turn", () => {
    const f = fixture();
    const prepared = prepare(f);
    const record = restoreRecord(f, prepared.attemptId);
    const owner = restoredLoopSupervisorMessage(record);
    const stale = restoredLoopSupervisorMessage(record);
    expect(owner?.started?.()).toBe(true);
    stale?.reject(new Error("stale cancellation"));
    expect(readDelegationAttempt(f.workOrder, "isolated-worker", prepared.attemptId).phase).toBe(
      "started",
    );
    expect(stale?.started?.()).toBe(false);
    stale?.resolve("late result from rejected claim");
    expect(() => prepare(f, "competing-turn")).toThrow();
    owner?.resolve("owner result");
    const state = readDelegationAttempt(f.workOrder, "isolated-worker", prepared.attemptId);
    expect(state.phase).toBe("settled");
    if (state.phase === "settled") expect(state.settled.output).toBe("owner result");
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
        true,
      ),
    ).toBe(true);
    expect(
      settleDelegationAttempt(
        f.workOrder,
        prepared,
        { status: 1, stdout: "", stderr: "late failure" },
        true,
        4,
        true,
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
