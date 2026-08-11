import { describe, expect, it } from "vitest";
import {
  buildRuntimeOverview,
  type OperatorInterfaceView,
  type RuntimeOverviewInput,
} from "../../../src/core/dashboard/runtime-overview.js";

const readyOperator: OperatorInterfaceView = {
  session: { state: "ready" },
  skills: { installed: 2, expected: 2, state: "ready" },
  mcpProfiles: { installed: 2, expected: 2, state: "ready" },
  promptLibrary: { state: "disabled" },
  optionalProjectMcpCount: 1,
};

function input(overrides: Partial<RuntimeOverviewInput> = {}): RuntimeOverviewInput {
  return {
    attention: [],
    activeWork: [],
    automation: [],
    runtimeDomains: [],
    operator: readyOperator,
    recentOutcomes: [],
    degradedDomains: [],
    ...overrides,
  };
}

describe("Runtime Overview policy", () => {
  it("reports healthy when every required domain is readable and no attention exists", () => {
    const overview = buildRuntimeOverview(input());

    expect(overview.health).toEqual({
      status: "healthy",
      attentionCount: 0,
      degradedDomainCount: 0,
    });
  });

  it("distinguishes attention from degraded domain reads", () => {
    expect(
      buildRuntimeOverview(
        input({
          attention: [
            {
              id: "loop:failed",
              domain: "automation",
              severity: "error",
              observedAt: 20,
              summary: "Loop failed",
              nextAction: "tcb loop reports list --limit 20",
            },
          ],
        }),
      ).health.status,
    ).toBe("attention");

    expect(
      buildRuntimeOverview(input({ degradedDomains: ["runtime-guardian"] })).health,
    ).toMatchObject({ status: "degraded", degradedDomainCount: 1 });
  });

  it("sorts deterministically and reports explicit truncation", () => {
    const overview = buildRuntimeOverview(
      input({
        attention: [
          {
            id: "warning-new",
            domain: "power",
            severity: "warning",
            observedAt: 30,
            summary: "warning",
            nextAction: "tcb power status",
          },
          {
            id: "error-old",
            domain: "automation",
            severity: "error",
            observedAt: 10,
            summary: "error",
            nextAction: "tcb automation status",
          },
          {
            id: "error-new",
            domain: "runtime-guardian",
            severity: "error",
            observedAt: 20,
            summary: "newer error",
            nextAction: "tcb logs --since 1h",
          },
        ],
        activeWork: [
          {
            id: "older",
            kind: "work-order",
            label: "older work",
            status: "running",
            startedAt: 10,
          },
          {
            id: "newer",
            kind: "interactive",
            label: "newer work",
            status: "busy",
            startedAt: 20,
          },
        ],
        recentOutcomes: [
          {
            id: "old",
            domain: "loop",
            label: "old",
            status: "passed",
            endedAt: 10,
          },
          {
            id: "new",
            domain: "loop",
            label: "new",
            status: "failed",
            endedAt: 20,
          },
        ],
      }),
      { attentionLimit: 2, activeWorkLimit: 1, recentOutcomeLimit: 1 },
    );

    expect(overview.attention.items.map((item) => item.id)).toEqual(["error-new", "error-old"]);
    expect(overview.attention).toMatchObject({ total: 3, limit: 2, truncated: true });
    expect(overview.activeWork.items.map((item) => item.id)).toEqual(["newer"]);
    expect(overview.activeWork).toMatchObject({ total: 2, limit: 1, truncated: true });
    expect(overview.recentOutcomes.items.map((item) => item.id)).toEqual(["new"]);
  });

  it("does not treat an absent optional integration as unhealthy", () => {
    const overview = buildRuntimeOverview(
      input({
        operator: {
          ...readyOperator,
          promptLibrary: { state: "disabled" },
          optionalProjectMcpCount: 0,
        },
      }),
    );

    expect(overview.health.status).toBe("healthy");
    expect(JSON.stringify(overview)).not.toMatch(/path|token|command/i);
  });
});
