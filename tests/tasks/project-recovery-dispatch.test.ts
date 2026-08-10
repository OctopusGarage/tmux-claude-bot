import { describe, expect, it, vi } from "vitest";
import { startActiveDelegatedTask } from "../../src/core/autopilot/delegated-task.js";
import {
  createProjectRecoveryDelegator,
  dispatchProjectRecovery,
  projectRecoveryLockKey,
} from "../../src/core/tasks/project-recovery-dispatch.js";

vi.mock("../../src/core/autopilot/delegated-task.js", () => ({
  startActiveDelegatedTask: vi.fn(async () => ({
    status: "queued",
    runId: "recovery-run-1",
    projectId: "alcove",
    supervisorSession: "tmux_proj_loop-supervisor",
    reportDir: "/tmp/recovery-report",
  })),
}));

describe("project recovery dispatch", () => {
  it("builds a project-scoped delegated task with the original evidence", async () => {
    const delegate = vi.fn(
      async (input: {
        session: string;
        requirement: string;
        worktreeIsolation: "source" | "isolated";
      }) => {
        expect(input.session).toContain("tmux_proj_");
        expect(input.requirement).toContain("Original task ids");
        expect(input.requirement).toContain("task-1");
        return { status: "queued" as const, runId: "recovery-run-1" };
      },
    );

    const result = await dispatchProjectRecovery(
      {
        target: { kind: "project", id: "alcove", name: "Alcove", path: "/repo/alcove" },
        taskFamily: "architecture",
        taskIds: ["task-1"],
        classification: { classification: "retryable", reason: "preflight failure" },
        evidence: ["pytest missing"],
      },
      { projectSessionPrefix: "tmux_proj_", worktreeIsolation: "isolated", delegate },
    );

    expect(result).toMatchObject({ status: "queued", runId: "recovery-run-1" });
    expect(delegate).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeIsolation: "isolated" }),
    );
  });

  it("uses a stable project lock key", () => {
    expect(
      projectRecoveryLockKey({ kind: "workspace", id: "geo", name: "Geo", path: "/repo/geo" }),
    ).toBe("workspace:geo");
  });

  it("returns a blocked result without claiming success", async () => {
    const result = await dispatchProjectRecovery(
      {
        target: { kind: "project", id: "alcove", name: "Alcove", path: "/repo/alcove" },
        taskFamily: "architecture",
        taskIds: ["task-1"],
        classification: { classification: "retryable", reason: "handoff" },
        evidence: ["worker handoff failed"],
      },
      {
        projectSessionPrefix: "tmux_proj_",
        worktreeIsolation: "source",
        delegate: async () => ({ status: "blocked", reason: "capacity" }),
      },
    );
    expect(result).toEqual({ status: "blocked", detail: "capacity" });
  });

  it("marks Project Recovery delegation as background work", async () => {
    const delegate = createProjectRecoveryDelegator({} as never);

    await expect(
      delegate({
        session: "tmux_proj_alcove",
        requirement: "repair the configured project",
        worktreeIsolation: "isolated",
      }),
    ).resolves.toEqual({ status: "queued", runId: "recovery-run-1" });

    expect(startActiveDelegatedTask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ resourceTrigger: "background" }),
    );
  });
});
