import { describe, expect, it } from "vitest";
import { buildDashboard } from "../src/core/dashboard/dashboard.js";
import { formatDashboardText } from "../src/core/dashboard/dashboard-view.js";

describe("dashboard CLI wiring", () => {
  it("the command's building blocks are importable functions", () => {
    expect(typeof buildDashboard).toBe("function");
    expect(typeof formatDashboardText).toBe("function");
  });
});
