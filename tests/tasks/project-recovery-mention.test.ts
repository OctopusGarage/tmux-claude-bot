import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileProjectRecoveryArtifacts } from "../../src/core/tasks/project-recovery-service.js";
import {
  InMemoryRepairQueueStore,
  RepairCoordinator,
} from "../../src/core/tasks/repair-coordinator.js";
import type { ScheduledTaskRecord } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;
beforeEach(() => {
  process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-recovery-mention-"));
});
afterEach(() => {
  if (process.env.TCB_STATE_DIR)
    rmSync(process.env.TCB_STATE_DIR, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("recovery requires an explicit repair link", () => {
  it.each(["summary", "artifact", "shared-occurrence", "linked"])(
    "does not infer repair completion from unowned task mentions: %s",
    async (evidence) => {
      const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
      const originals: ScheduledTaskRecord[] = ["1000000000000", "1000000000001"].map(
        (occurrence) => ({
          taskId: `loop:suite:bug-fix:${occurrence}`,
          source: "loop-engineering",
          name: "suite bug-fix",
          status: "missing",
          repairStatus: "pending",
          scheduledAt: Number(occurrence),
          updatedAt: Number(occurrence),
        }),
      );
      const [first, second] = originals;
      if (!first || !second) throw new Error("missing original fixtures");
      const queue = coordinator.enqueue({
        projectId: "suite",
        projectPath: "/repo/suite",
        source: "project-recovery",
        taskFamily: "suite bug-fix",
        fingerprint: "missing-run-record",
        taskId: first.taskId,
        now: 1000000000002,
      });
      coordinator.linkTaskIds(queue.id, [second.taskId], 1000000000002);
      const investigation: ScheduledTaskRecord = {
        taskId: "autopilot:investigation",
        source: "autopilot-delegate",
        name: "bot investigation",
        status: "success",
        repairStatus: "not-needed",
        scheduledAt: 1000000000010,
        updatedAt: 1000000000020,
        summary:
          evidence === "shared-occurrence"
            ? "Other project loop:other:bug-fix:1000000000000 remains queued."
            : `Investigated ${first.taskId}; existing recovery remains pending.`,
      };
      if (evidence === "artifact") {
        const stateDir = process.env.TCB_STATE_DIR;
        if (!stateDir) throw new Error("missing fixture state directory");
        const runDir = join(stateDir, "investigation");
        mkdirSync(runDir);
        writeFileSync(
          join(runDir, "supervisor-final-summary.json"),
          JSON.stringify({ status: "completed", followUps: [investigation.summary] }),
        );
        investigation.summary = "Investigation completed; no target repair executed.";
        investigation.reportPath = runDir;
      }
      if (evidence === "linked")
        coordinator.linkTaskIds(queue.id, [investigation.taskId], 1000000000020);
      const updateRepairStatus = vi.fn();
      await reconcileProjectRecoveryArtifacts({
        now: 1000000000030,
        records: [...originals, investigation],
        coordinator,
        updateRepairStatus,
      });
      if (evidence === "linked") {
        for (const original of originals)
          expect(updateRepairStatus).toHaveBeenCalledWith(
            original.taskId,
            "fixed",
            expect.any(String),
          );
        expect(coordinator.list()[0]?.status).toBe("fixed");
      } else {
        expect(updateRepairStatus).not.toHaveBeenCalled();
        expect(coordinator.list()[0]).toEqual(
          expect.objectContaining({ id: queue.id, status: "pending", attempt: 0 }),
        );
      }
    },
  );
});
