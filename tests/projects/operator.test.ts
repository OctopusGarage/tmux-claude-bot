import { describe, expect, it } from "vitest";
import {
  homeCommandResult,
  isOperator,
  isReservedInfrastructureSession,
  listUserProjectSessions,
  loopSupervisorSessionNames,
  loopWorkerSessionName,
  operatorSessionName,
  resolveTargetSession,
} from "../../src/core/projects/operator.js";

describe("operator identity", () => {
  it("derives the reserved session name from the prefix", () => {
    expect(operatorSessionName("tmux_proj_")).toBe("tmux_proj_home");
  });
  it("isOperator matches only the reserved name", () => {
    expect(isOperator("tmux_proj_home", "tmux_proj_")).toBe(true);
    expect(isOperator("tmux_proj_free_1", "tmux_proj_")).toBe(false);
  });
  it("recognizes reserved infrastructure sessions", () => {
    expect(isReservedInfrastructureSession("tmux_proj_home", "tmux_proj_")).toBe(true);
    expect(isReservedInfrastructureSession("tmux_proj_loop-supervisor", "tmux_proj_")).toBe(true);
    expect(isReservedInfrastructureSession("tmux_proj_loop-supervisor-2", "tmux_proj_")).toBe(true);
    expect(isReservedInfrastructureSession("tmux_proj_loop-worker-api", "tmux_proj_")).toBe(true);
    expect(isReservedInfrastructureSession("tmux_proj_free_1", "tmux_proj_")).toBe(false);
  });
  it("derives stable reserved loop worker names from project ids", () => {
    expect(loopWorkerSessionName("tmux_proj_", "geo-backend")).toBe(
      "tmux_proj_loop-worker-geo-backend",
    );
    expect(loopWorkerSessionName("tmux_proj_", "geo.backend")).toBe(
      "tmux_proj_loop-worker-geo_backend",
    );
  });
  it("keeps the legacy supervisor name for a single slot and numbered names for pools", () => {
    expect(loopSupervisorSessionNames("tmux_proj_", 1)).toEqual(["tmux_proj_loop-supervisor"]);
    expect(loopSupervisorSessionNames("tmux_proj_", 3)).toEqual([
      "tmux_proj_loop-supervisor-1",
      "tmux_proj_loop-supervisor-2",
      "tmux_proj_loop-supervisor-3",
    ]);
  });
});

describe("resolveTargetSession (routing fallback)", () => {
  it("keeps an explicit current project", () => {
    expect(resolveTargetSession("tmux_proj_x", true, "tmux_proj_")).toBe("tmux_proj_x");
  });
  it("falls back to the operator when none and enabled", () => {
    expect(resolveTargetSession(null, true, "tmux_proj_")).toBe("tmux_proj_home");
  });
  it("returns null when none and operator disabled", () => {
    expect(resolveTargetSession(null, false, "tmux_proj_")).toBeNull();
  });
  it("returns null when current is the operator but operator is disabled (stale pointer)", () => {
    expect(resolveTargetSession("tmux_proj_home", false, "tmux_proj_")).toBeNull();
  });
  it("returns the operator when current is the operator and operator is enabled", () => {
    expect(resolveTargetSession("tmux_proj_home", true, "tmux_proj_")).toBe("tmux_proj_home");
  });
  it("returns the real project even when operator is disabled (non-operator current is unaffected)", () => {
    expect(resolveTargetSession("tmux_proj_real", false, "tmux_proj_")).toBe("tmux_proj_real");
  });
});

describe("listUserProjectSessions", () => {
  const PREFIX = "tmux_proj_";

  function fakeDepsFor(sessions: string[]) {
    return {
      bridge: { listProjectSessions: async () => sessions },
      config: { projectSessionPrefix: PREFIX },
    };
  }

  it("filters out reserved infrastructure sessions, keeps real user projects", async () => {
    const deps = fakeDepsFor([
      "tmux_proj_home",
      "tmux_proj_loop-supervisor",
      "tmux_proj_loop-supervisor-1",
      "tmux_proj_loop-worker-my-app",
      "tmux_proj_-my-app",
      "tmux_proj_free_1",
    ]);
    const result = await listUserProjectSessions(deps);
    expect(result).not.toContain("tmux_proj_home");
    expect(result).not.toContain("tmux_proj_loop-supervisor");
    expect(result).not.toContain("tmux_proj_loop-supervisor-1");
    expect(result).not.toContain("tmux_proj_loop-worker-my-app");
    expect(result).toContain("tmux_proj_-my-app");
    expect(result).toContain("tmux_proj_free_1");
  });

  it("returns an empty list when only infrastructure is live", async () => {
    const deps = fakeDepsFor(["tmux_proj_home", "tmux_proj_loop-supervisor"]);
    expect(await listUserProjectSessions(deps)).toEqual([]);
  });

  it("passes through all sessions when the operator is not in the list", async () => {
    const sessions = ["tmux_proj_-a", "tmux_proj_-b"];
    const deps = fakeDepsFor(sessions);
    expect(await listUserProjectSessions(deps)).toEqual(sessions);
  });
});

describe("homeCommandResult (/home command helper)", () => {
  it("returns switched result with operator session when enabled", () => {
    expect(homeCommandResult(true, "tmux_proj_")).toEqual({
      ok: true,
      session: "tmux_proj_home",
    });
  });
  it("returns disabled result when operator not enabled", () => {
    expect(homeCommandResult(false, "tmux_proj_")).toEqual({ ok: false });
  });
});
