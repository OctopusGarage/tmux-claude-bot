// tests/scheduler/scheduling.test.ts
import { describe, expect, it } from "vitest";
import {
  hasActiveRun,
  materializeRun,
  nextCronFire,
  nextFire,
} from "../../src/core/scheduler/scheduling.js";
import type { Plan } from "../../src/core/scheduler/types.js";

const at = (s: string) => new Date(`${s}Z`).getTime();

describe("nextCronFire", () => {
  it("daily 02:00 → next 02:00 UTC after the given instant", () => {
    expect(nextCronFire("0 2 * * *", at("2026-06-23T01:59:00"))).toBe(at("2026-06-23T02:00:00"));
    expect(nextCronFire("0 2 * * *", at("2026-06-23T02:00:00"))).toBe(at("2026-06-24T02:00:00")); // strictly after
  });
  it("*/30 every half hour", () => {
    expect(nextCronFire("*/30 * * * *", at("2026-06-23T10:05:00"))).toBe(at("2026-06-23T10:30:00"));
  });
  it("null on a malformed expression", () => {
    expect(nextCronFire("nonsense", 0)).toBeNull();
  });

  // Bug #7: N/step (e.g. 5/15 = minutes 5,20,35,50) must expand to full range from base.
  it("5/15 minute field fires at :05 :20 :35 :50 (N/step expands hi to max)", () => {
    // Before :05 → fires at :05
    expect(nextCronFire("5/15 * * * *", at("2026-06-23T10:00:00"))).toBe(at("2026-06-23T10:05:00"));
    // After :05, before :20 → fires at :20
    expect(nextCronFire("5/15 * * * *", at("2026-06-23T10:05:00"))).toBe(at("2026-06-23T10:20:00"));
    // After :20 → fires at :35
    expect(nextCronFire("5/15 * * * *", at("2026-06-23T10:20:00"))).toBe(at("2026-06-23T10:35:00"));
    // After :35 → fires at :50
    expect(nextCronFire("5/15 * * * *", at("2026-06-23T10:35:00"))).toBe(at("2026-06-23T10:50:00"));
    // After :50 → wraps to next hour :05
    expect(nextCronFire("5/15 * * * *", at("2026-06-23T10:50:00"))).toBe(at("2026-06-23T11:05:00"));
  });

  it("*/15 still fires at :00 :15 :30 :45 (unchanged)", () => {
    expect(nextCronFire("*/15 * * * *", at("2026-06-23T10:00:00"))).toBe(at("2026-06-23T10:15:00"));
    expect(nextCronFire("*/15 * * * *", at("2026-06-23T10:44:00"))).toBe(at("2026-06-23T10:45:00"));
  });

  it("5-20/15 fires only at :05 and :20 (explicit range, unchanged)", () => {
    // :05 is first, :20 is second, then wraps to next hour :05
    expect(nextCronFire("5-20/15 * * * *", at("2026-06-23T10:00:00"))).toBe(
      at("2026-06-23T10:05:00"),
    );
    expect(nextCronFire("5-20/15 * * * *", at("2026-06-23T10:05:00"))).toBe(
      at("2026-06-23T10:20:00"),
    );
    expect(nextCronFire("5-20/15 * * * *", at("2026-06-23T10:20:00"))).toBe(
      at("2026-06-23T11:05:00"),
    );
  });
});
describe("nextFire", () => {
  it("now → after; at → the time if future else null", () => {
    expect(nextFire({ kind: "now" }, 5)).toBe(5);
    expect(nextFire({ kind: "at", at: 10 }, 5)).toBe(10);
    expect(nextFire({ kind: "at", at: 3 }, 5)).toBeNull();
  });
});
describe("materializeRun", () => {
  it("turns plan projects into queued tasks with defaults applied", () => {
    const plan: Plan = {
      id: "p",
      name: "n",
      pools: { claude: 2 },
      defaults: { rounds: 3, retries: 1 },
      projects: [
        { path: "/a", agent: "claude", goals: ["fix-tests"] },
        { path: "/b", agent: "codex", goals: ["fix-tests"], rounds: 1, priority: 5 },
      ],
    };
    const run = materializeRun(plan, "r1", 1000);
    expect(run.status).toBe("running");
    expect(run.tasks).toHaveLength(2);
    expect(run.tasks[0]).toMatchObject({
      project: "/a",
      status: "queued",
      rounds: 3,
      retries: 1,
      priority: 0,
      attempt: 0,
    });
    expect(run.tasks[1]).toMatchObject({ project: "/b", rounds: 1, priority: 5 });
  });
});
describe("hasActiveRun", () => {
  it("true for running/paused, false otherwise", () => {
    expect(hasActiveRun(undefined)).toBe(false);
    expect(hasActiveRun({ runId: "r", planId: "p", startedAt: 0, status: "done", tasks: [] })).toBe(
      false,
    );
    expect(
      hasActiveRun({ runId: "r", planId: "p", startedAt: 0, status: "running", tasks: [] }),
    ).toBe(true);
  });
});
