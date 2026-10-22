import { describe, expect, it, vi } from "vitest";
import { createProductionProcessOwnershipCollector } from "../../src/core/resource-guardian/ownership.js";
import type { ResourceProcess } from "../../src/core/resource-guardian/types.js";

const pane: ResourceProcess = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  startedAt: "2026-01-01T00:00:00.000Z",
  cpuPct: 0,
  rssKb: 1,
  command: "sh",
};
const child: ResourceProcess = { ...pane, pid: 101, ppid: 100, cpuPct: 90, command: "node" };

function collectorInput(paneSnapshot: () => Promise<ReadonlyMap<string, readonly number[]>>) {
  const history = Array.from({ length: 10_000 }, (_, index) => ({
    id: `old-wo-${index}`,
    workerSession: `old-worker-${index}`,
    supervisorSession: "supervisor",
    status: "completed" as const,
  }));
  return {
    sessions: ["worker", ...history.map((record) => record.workerSession)],
    paneSnapshot,
    processProbe: async () => ({
      capturedAt: 100,
      thermal: "unknown" as const,
      processes: [pane, child],
    }),
    readWorkOrders: () => [
      {
        id: "wo",
        workerSession: "worker",
        supervisorSession: "supervisor",
        status: "completed" as const,
      },
      ...history,
    ],
    readLeases: () => [
      {
        id: "lease",
        workOrderId: "wo",
        supervisorSession: "supervisor",
        status: "active" as const,
      },
    ],
    introspector: { cwdOf: async () => null },
    now: () => 100,
  };
}

describe("bounded Resource Guardian pane observations", () => {
  it("uses two bulk reads despite ten thousand historical sessions and retains terminal ownership", async () => {
    const paneSnapshot = vi.fn(async () => new Map([["worker", [100]]]));
    const input = collectorInput(paneSnapshot);

    const result = await createProductionProcessOwnershipCollector(input).collect();

    expect(paneSnapshot).toHaveBeenCalledTimes(2);
    expect(result.ownership.find((entry) => entry.process.pid === 101)).toMatchObject({
      classification: "bot-terminal",
      strong: true,
      workOrderId: "wo",
    });
  });

  it("rejects changed pane identities between independent bulk observations", async () => {
    const paneSnapshot = vi
      .fn<() => Promise<ReadonlyMap<string, readonly number[]>>>()
      .mockResolvedValueOnce(new Map([["worker", [100]]]))
      .mockResolvedValueOnce(new Map([["worker", [101]]]));

    const result = await createProductionProcessOwnershipCollector(
      collectorInput(paneSnapshot),
    ).collect();

    expect(result.ownership.find((entry) => entry.process.pid === 101)).toMatchObject({
      classification: "unknown",
      strong: false,
      evidence: ["unstable-pane-pid"],
    });
  });

  it.each([
    { label: "disappears", before: [100], after: [] },
    { label: "appears", before: [], after: [100] },
  ])(
    "rejects ownership when a pane $label around the process snapshot",
    async ({ before, after }) => {
      const paneSnapshot = vi
        .fn<() => Promise<ReadonlyMap<string, readonly number[]>>>()
        .mockResolvedValueOnce(new Map([["worker", before]]))
        .mockResolvedValueOnce(new Map([["worker", after]]));

      const result = await createProductionProcessOwnershipCollector(
        collectorInput(paneSnapshot),
      ).collect();

      expect(result.ownership.find((entry) => entry.process.pid === 101)).toMatchObject({
        classification: "unknown",
        strong: false,
        evidence: ["unstable-pane-pid"],
      });
    },
  );

  it("retains ownership for descendants of every stable pane in a worker session", async () => {
    const paneSnapshot = vi.fn(async () => new Map([["worker", [100, 200]]]));
    const input = collectorInput(paneSnapshot);
    const result = await createProductionProcessOwnershipCollector({
      ...input,
      processProbe: async () => ({
        capturedAt: 100,
        thermal: "unknown",
        processes: [pane, child, { ...pane, pid: 200 }, { ...child, pid: 201, ppid: 200 }],
      }),
    }).collect();

    for (const pid of [101, 201]) {
      expect(result.ownership.find((entry) => entry.process.pid === pid)).toMatchObject({
        classification: "bot-terminal",
        strong: true,
        workOrderId: "wo",
      });
    }
    expect(paneSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2])("fails closed when bulk observation %i fails", async (failedRead) => {
    let reads = 0;
    const input = collectorInput(async () => {
      if (++reads === failedRead) throw new Error("tmux observation failed");
      return new Map([["worker", [100]]]);
    });

    await expect(createProductionProcessOwnershipCollector(input).collect()).rejects.toThrow(
      "tmux observation failed",
    );
  });
});
