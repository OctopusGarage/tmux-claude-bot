import { describe, expect, it } from "vitest";
import { allocateLoopSupervisorBatches } from "../../src/core/loop/supervisor-pool.js";

describe("allocateLoopSupervisorBatches", () => {
  it("fills supervisor slots while keeping the same project path out of the same batch", () => {
    const batches = allocateLoopSupervisorBatches(
      [
        { id: "a", projectPath: "/repo/a" },
        { id: "a-review", projectPath: "/repo/a" },
        { id: "b", projectPath: "/repo/b" },
        { id: "c", projectPath: "/repo/c" },
      ],
      ["supervisor-1", "supervisor-2"],
    );

    expect(batches.map((batch) => batch.map((entry) => entry.item.id))).toEqual([
      ["a", "b"],
      ["a-review", "c"],
    ]);
    expect(batches[0]?.map((entry) => entry.supervisorSession)).toEqual([
      "supervisor-1",
      "supervisor-2",
    ]);
  });
});
