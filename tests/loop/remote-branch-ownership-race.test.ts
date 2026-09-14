import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLoopRemoteBranchMaintenance } from "../../src/core/loop/remote-branch-maintenance.js";
import { writeLoopSupervisorWorkerLeaseState } from "../../src/core/loop/supervisor-pool.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";

describe("remote maintenance live lease revalidation", () => {
  it.each([2, 3])(
    "retains a terminal branch when a lease becomes active during ref read %i",
    async (activateAt) => {
      const root = mkdtempSync(join(tmpdir(), "tcb-remote-lease-race-"));
      const previousStateDir = process.env.TCB_STATE_DIR;
      process.env.TCB_STATE_DIR = root;
      try {
        const now = Date.now();
        const branch = "loop/sample/architecture/sample-worker";
        const workOrder: LoopWorkOrder = {
          id: "sample-worker",
          scheduledAt: now,
          projectId: "sample",
          projectName: "Sample",
          projectPath: root,
          agent: "codex",
          goal: "Maintain sample",
          maxRounds: 1,
          targetScore: 90,
          runner: { kind: "agent-supervised", requireConfirmation: false },
          allowedActions: ["tests"],
          blockedActions: [],
          skills: { approved: [] },
          preflight: { commands: [], repair: { agent: false } },
          assessment: { command: "true" },
          execution: { agent: true },
          recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
          commitPolicy: { enabled: true, perRound: false, branch },
          requiredFinalMarker: "[DONE]",
        };
        writeLoopSupervisorWorkOrderState({
          workOrder,
          supervisorSession: "sample-supervisor",
          status: "failed",
          resultStatus: "supervisor-failed",
          now,
        });
        const configFile = join(root, "loop.yml");
        writeFileSync(
          configFile,
          `projects:
  - id: sample
    name: Sample
    path: ${root}
    agent: codex
    goal: Maintain sample
    maxRounds: 1
    targetScore: 90
    assessment: { command: "true" }
    execution: { agent: true }
    commit: { enabled: true, branch: loop/sample/architecture }
    pullRequest: { enabled: true, base: dev, switchBack: dev, githubAccount: sample-owner }
    allowedActions: [tests]
`,
        );
        let refReads = 0;
        const deletions: string[] = [];
        const maintenance = createLoopRemoteBranchMaintenance({
          configFile,
          runGit: async () => ({ status: 0, stdout: root, stderr: "" }),
          runCommand: async ({ command }) => {
            await Promise.resolve();
            let data: unknown = { default_branch: "main" };
            if (command.includes("repo view")) data = { nameWithOwner: "sample-owner/sample" };
            if (command.includes("matching-refs")) data = [{ ref: `refs/heads/${branch}` }];
            if (command.includes("/git/ref/heads/")) {
              if (++refReads === activateAt)
                writeLoopSupervisorWorkerLeaseState({
                  leases: [
                    {
                      workerSession: "sample-supervisor",
                      workOrderId: workOrder.id,
                      projectId: workOrder.projectId,
                      projectPath: root,
                      status: "active",
                      leasedAt: now,
                      updatedAt: now,
                    },
                  ],
                });
              data = { object: { sha: "abc123" } };
            }
            if (command.includes("/branches/")) data = { protected: false };
            if (command.includes("/pulls?"))
              data = [
                {
                  number: 1,
                  state: "closed",
                  merged_at: "2026-01-01T00:00:00Z",
                  head: { ref: branch, sha: "abc123", repo: { full_name: "sample-owner/sample" } },
                  base: { ref: "dev" },
                },
              ];
            if (command.includes("--method DELETE")) deletions.push(command);
            return { status: 0, stdout: JSON.stringify(data), stderr: "" };
          },
        });
        const result = await maintenance.reconcile(now);
        expect(refReads).toBe(activateAt);
        expect(deletions).toEqual([]);
        expect(result).toMatchObject({ scanned: 1, eligible: 1, deleted: 0, failed: 1 });
      } finally {
        if (previousStateDir === undefined) delete process.env.TCB_STATE_DIR;
        else process.env.TCB_STATE_DIR = previousStateDir;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
