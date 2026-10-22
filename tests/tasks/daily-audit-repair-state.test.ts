import { describe, expect, it } from "vitest";
import { reconcileDailyAuditRepairState } from "../../src/core/tasks/daily-audit-repair-state.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

describe("daily audit repair state", () => {
  it("leaves an empty ledger unchanged", () => {
    expect(
      reconcileDailyAuditRepairState({
        ledger: new DailyTaskLedger(),
        now: 2_000,
      }),
    ).toEqual({ reopened: 0 });
  });
});
