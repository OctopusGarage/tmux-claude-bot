import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runArchitectureQuarantineCommand } from "../../src/core/loop/architecture-command.js";
import {
  listLoopExecutionQuarantines,
  quarantineLoopExecution,
  releaseLoopExecutionQuarantine,
} from "../../src/core/loop/execution-quarantine.js";
import {
  cleanupLoopExecutionWorktree,
  prepareLoopExecutionWorktrees,
} from "../../src/core/loop/execution-worktree.js";
import { readActiveLoopSupervisorResources } from "../../src/core/loop/supervisor-active-resources.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { createBulkResourceProcessProbe } from "../../src/core/resource-guardian/ownership.js";

const original = process.env.TCB_STATE_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = original;
});

describe("uncertain external process ownership", () => {
  it("durably blocks source and worktree reuse and cleanup beyond ordinary failure retention", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-quarantine-"));
    const path = join(process.env.TCB_STATE_DIR, "loop-worktrees/project/run-1");
    const order = {
      id: "run-1",
      projectId: "project",
      projectPath: path,
      workerSession: "worker",
      executionIsolation: { sourceWorktree: "/repo/source" },
    } as LoopWorkOrder;
    quarantineLoopExecution(order, "process termination unverified");
    expect(listLoopExecutionQuarantines()).toHaveLength(1);
    const resources = readActiveLoopSupervisorResources();
    expect(resources.resourcePaths.has(path)).toBe(true);
    expect(resources.resourcePaths.has("/repo/source")).toBe(true);
    let gitCalls = 0;
    expect(
      cleanupLoopExecutionWorktree({
        worktree: path,
        sourceWorktree: "/repo/source",
        runGit: () => {
          gitCalls++;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    ).toBe(false);
    let blocked = false;
    prepareLoopExecutionWorktrees({
      workOrder: { ...order, id: "run-2", projectPath: "/repo/source" },
      runGit: () => {
        gitCalls++;
        return { status: 0, stdout: "", stderr: "" };
      },
      onPreparationFailure: () => {
        blocked = true;
      },
    });
    expect(blocked).toBe(true);
    blocked = false;
    const workspaceOrder = { ...order };
    delete workspaceOrder.executionIsolation;
    prepareLoopExecutionWorktrees({
      workOrder: {
        ...workspaceOrder,
        id: "workspace-run",
        projectPath: "/workspace",
        workspace: {
          root: "/workspace",
          repositories: [
            {
              id: "member",
              name: "Member",
              path: "/repo/source",
              role: "member",
              agent: "codex",
              pullRequest: {
                enabled: false,
                base: "main",
                switchBack: "main",
                autoMerge: false,
                mergeMethod: "squash",
              },
            },
          ],
        },
      } as LoopWorkOrder,
      runGit: () => {
        gitCalls++;
        return { status: 1, stdout: "", stderr: "unexpected git" };
      },
      onPreparationFailure: () => {
        blocked = true;
      },
    });
    expect(blocked).toBe(true);
    expect(gitCalls).toBe(0);
    expect(() => releaseLoopExecutionQuarantine("run-1", false)).toThrow();
    releaseLoopExecutionQuarantine("run-1", true);
    expect(listLoopExecutionQuarantines()).toEqual([]);
  });
  it("requires operator acknowledgment and refuses release while a recorded identity is live", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-quarantine-live-"));
    const snapshot = await createBulkResourceProcessProbe({})();
    const current = snapshot.processes.find((entry) => entry.pid === process.pid);
    if (current === undefined) throw new Error("current process unavailable");
    const order = {
      id: "live-process",
      projectId: "fixture",
      projectPath: "/repo/private-source",
    } as LoopWorkOrder;
    quarantineLoopExecution(order, "Process reconciliation required", [current]);
    expect(() => releaseLoopExecutionQuarantine(order.id, true)).toThrow("still running");
    const result = runArchitectureQuarantineCommand({ action: "list" });
    expect(result.stdout).toContain("live-process");
    expect(result.stdout).not.toContain("/repo/private-source");
    expect(
      runArchitectureQuarantineCommand({
        action: "release",
        workOrderId: order.id,
        processesStopped: true,
      }).exitCode,
    ).toBe(1);
  });
});
