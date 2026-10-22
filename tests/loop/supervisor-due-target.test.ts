import { describe, expect, it } from "vitest";
import type { LoopConfig } from "../../src/core/loop/config.js";
import { resolveLoopSupervisorDueTarget } from "../../src/core/loop/supervisor-due-target.js";

describe("resolveLoopSupervisorDueTarget", () => {
  it("resolves a scheduled project to its configured path", () => {
    const config = {
      projects: [{ id: "hub", path: "/repo/hub" }],
      workspaces: [],
      prReview: { repositories: [] },
    } as unknown as LoopConfig;
    const due = {
      projectId: "hub",
      name: "Hub",
      jobKey: "architecture:hub",
      jobKind: "architecture",
      scheduledAt: 1,
      effectiveAt: 1,
      jitterMs: 0,
      action: "would-run",
    } as const;

    expect(resolveLoopSupervisorDueTarget(config, due)).toMatchObject({ projectPath: "/repo/hub" });
  });
});
