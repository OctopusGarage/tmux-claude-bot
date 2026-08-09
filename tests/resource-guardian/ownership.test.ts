import { describe, expect, it, vi } from "vitest";
import {
  createBulkResourceProcessProbe,
  createProcessOwnershipResolver,
  createProductionProcessOwnershipCollector,
  createSupervisorProcessOwnershipCollector,
  normalizeSupervisorLeaseEvidence,
  normalizeSupervisorWorkOrderEvidence,
  parseResourceProcessPs,
  sameProcessInstance,
} from "../../src/core/resource-guardian/ownership.js";
import type { ResourceProcess } from "../../src/core/resource-guardian/types.js";

const process = (overrides: Partial<ResourceProcess> & { pid: number }): ResourceProcess => ({
  ppid: 1,
  pgid: overrides.pid,
  startedAt: "2026-08-09T00:00:00.000Z",
  cpuPct: 1,
  rssKb: 1,
  command: "sh",
  ...overrides,
});

const activeWorkOrder = {
  id: "wo-1",
  workerSession: "worker-1",
  supervisorSession: "supervisor-1",
  status: "in-flight" as const,
};
const terminalWorkOrder = { ...activeWorkOrder, status: "completed" as const };
const activeLease = {
  id: "lease-1",
  workOrderId: "wo-1",
  supervisorSession: "supervisor-1",
  status: "active" as const,
};

describe("sameProcessInstance", () => {
  it("requires both the pid and stable start time", () => {
    expect(
      sameProcessInstance(
        { pid: 10, startedAt: "2026-08-09T00:00:00.000Z" },
        { pid: 10, startedAt: "2026-08-09T00:00:00.000Z" },
      ),
    ).toBe(true);
    expect(
      sameProcessInstance(
        { pid: 10, startedAt: "2026-08-09T00:00:00.000Z" },
        { pid: 10, startedAt: "2026-08-09T00:01:00.000Z" },
      ),
    ).toBe(false);
    expect(
      sameProcessInstance(
        { pid: 10, pgid: 10, startedAt: "2026-08-09T00:00:00.000Z" },
        { pid: 10, pgid: 11, startedAt: "2026-08-09T00:00:00.000Z" },
      ),
    ).toBe(false);
    expect(
      sameProcessInstance(
        { pid: 10, startedAt: "2026-08-09T00:00:00.000Z" },
        { pid: 11, startedAt: "2026-08-09T00:00:00.000Z" },
      ),
    ).toBe(false);
  });
});

describe("createProcessOwnershipResolver", () => {
  it("proves every descendant of a consistently leased pane is bot-active", () => {
    const pane = process({ pid: 100, command: "-zsh" });
    const resolver = createProcessOwnershipResolver({
      processes: [pane, process({ pid: 101, ppid: 100 }), process({ pid: 102, ppid: 101 })],
      panes: [{ session: "worker-1", pane }],
      workOrders: [activeWorkOrder],
      leases: [activeLease],
      now: 100,
    });

    for (const pid of [101, 102]) {
      expect(resolver.resolve(pid)).toMatchObject({
        classification: "bot-active",
        strong: true,
        session: "worker-1",
        workOrderId: "wo-1",
        leaseId: "lease-1",
      });
    }
  });

  it("correlates worker and supervisor panes through distinct durable sessions", () => {
    const workerPane = process({ pid: 100 });
    const workerChild = process({ pid: 101, ppid: 100 });
    const supervisorPane = process({ pid: 200 });
    const supervisorChild = process({ pid: 201, ppid: 200 });
    const resolver = createProcessOwnershipResolver({
      processes: [workerPane, workerChild, supervisorPane, supervisorChild],
      panes: [
        { session: "worker-1", pane: workerPane },
        { session: "supervisor-1", pane: supervisorPane },
      ],
      workOrders: [activeWorkOrder],
      leases: [activeLease],
      now: 100,
    });

    expect(resolver.resolve(101)).toMatchObject({ classification: "bot-active", strong: true });
    expect(resolver.resolve(201)).toMatchObject({ classification: "bot-active", strong: true });
    expect(
      createProcessOwnershipResolver({
        processes: [workerPane, workerChild],
        panes: [{ session: "worker-1", pane: workerPane }],
        workOrders: [activeWorkOrder],
        leases: [{ ...activeLease, supervisorSession: "other-supervisor" }],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "unknown", strong: false });
  });

  it("treats an unrelated ordinary process as external", () => {
    const ordinary = process({ pid: 9, command: "Safari" });
    expect(
      createProcessOwnershipResolver({ processes: [ordinary], now: 100 }).resolve(9),
    ).toMatchObject({
      classification: "external",
      strong: false,
    });
  });

  it.each(["claude --resume x", "codex", "pytest -q", "node worker.js", "tmux new-session"])(
    "does not use automation-looking command %s as ownership proof",
    (command) => {
      const candidate = process({ pid: 9, command });
      expect(
        createProcessOwnershipResolver({ processes: [candidate], now: 100 }).resolve(9),
      ).toMatchObject({ classification: "unknown", strong: false });
    },
  );

  it("proves a terminal WorkOrder only when pane/session/lease evidence remains consistent", () => {
    const pane = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    expect(
      createProcessOwnershipResolver({
        processes: [pane, child],
        panes: [{ session: "worker-1", pane }],
        workOrders: [terminalWorkOrder],
        leases: [activeLease],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "bot-terminal", strong: true, workOrderId: "wo-1" });
  });

  it("uses a unique supervisor reservation to select the current WorkOrder after session reuse", () => {
    const pane = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    const oldTerminal = { ...terminalWorkOrder, id: "wo-old" };
    expect(
      createProcessOwnershipResolver({
        processes: [pane, child],
        panes: [{ session: "supervisor-1", pane }],
        workOrders: [oldTerminal, activeWorkOrder],
        leases: [activeLease],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "bot-active", strong: true, workOrderId: "wo-1" });
    expect(
      createProcessOwnershipResolver({
        processes: [pane, child],
        panes: [{ session: "supervisor-1", pane }],
        workOrders: [oldTerminal, activeWorkOrder],
        leases: [activeLease, { ...activeLease, id: "lease-2" }],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "unknown", strong: false });
  });

  it("refuses pane-derived terminal attribution when its durable lease is absent", () => {
    const pane = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });

    expect(
      createProcessOwnershipResolver({
        processes: [pane, child],
        panes: [{ session: "worker-1", pane }],
        workOrders: [terminalWorkOrder],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "unknown", strong: false });
  });

  it("classifies a nonterminal WorkOrder with an expired correlated lease as bot-stale at the expiry boundary", () => {
    const pane = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    const stale = { ...activeLease, status: "retained" as const, retainUntil: 100 };
    expect(
      createProcessOwnershipResolver({
        processes: [pane, child],
        panes: [{ session: "worker-1", pane }],
        workOrders: [activeWorkOrder],
        leases: [stale],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "bot-stale", strong: true, leaseId: "lease-1" });
  });

  it("treats a retained lease without retainUntil as expired", () => {
    const pane = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    expect(
      createProcessOwnershipResolver({
        processes: [pane, child],
        panes: [{ session: "worker-1", pane }],
        workOrders: [activeWorkOrder],
        leases: [{ ...activeLease, status: "retained" }],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "bot-stale", strong: true });
  });

  it("refuses contradictory pane, WorkOrder, and lease evidence", () => {
    const pane = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    expect(
      createProcessOwnershipResolver({
        processes: [pane, child],
        panes: [{ session: "worker-1", pane }],
        workOrders: [activeWorkOrder],
        leases: [{ ...activeLease, supervisorSession: "other-worker" }],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "unknown", strong: false });
  });

  it("refuses multiple WorkOrders or leases that could claim the same pane", () => {
    const pane = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    const base = { processes: [pane, child], panes: [{ session: "worker-1", pane }], now: 100 };

    expect(
      createProcessOwnershipResolver({
        ...base,
        workOrders: [activeWorkOrder, { ...activeWorkOrder, id: "wo-2" }],
        leases: [activeLease],
      }).resolve(101),
    ).toMatchObject({ classification: "unknown", strong: false });
    expect(
      createProcessOwnershipResolver({
        ...base,
        workOrders: [activeWorkOrder],
        leases: [activeLease, { ...activeLease, id: "lease-2" }],
      }).resolve(101),
    ).toMatchObject({ classification: "unknown", strong: false });
  });

  it("uses an exact launch instance plus durable WorkOrder session evidence for bot launch ancestry", () => {
    const launcher = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    const ownership = createProcessOwnershipResolver({
      processes: [launcher, child],
      launches: [{ process: launcher, session: "worker-1", workOrderId: "wo-1" }],
      workOrders: [activeWorkOrder],
      now: 100,
    }).resolve(101);
    expect(ownership).toMatchObject({ classification: "bot-active", strong: true });

    expect(
      createProcessOwnershipResolver({
        processes: [launcher, child],
        launches: [
          {
            process: { ...launcher, startedAt: "2026-08-09T00:01:00.000Z" },
            session: "worker-1",
            workOrderId: "wo-1",
          },
        ],
        workOrders: [activeWorkOrder],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "unknown", strong: false });
  });

  it("accepts a durable launch record that has pid and start time but no pgid", () => {
    const launcher = process({ pid: 100, pgid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    expect(
      createProcessOwnershipResolver({
        processes: [launcher, child],
        launches: [
          {
            process: { pid: 100, startedAt: launcher.startedAt },
            session: "worker-1",
            workOrderId: "wo-1",
          },
        ],
        workOrders: [activeWorkOrder],
        now: 100,
      }).resolve(101),
    ).toMatchObject({ classification: "bot-active", strong: true });
  });

  it("terminates safely on a process cycle or missing parent", () => {
    const a = process({ pid: 100, ppid: 101 });
    const b = process({ pid: 101, ppid: 100 });
    expect(
      createProcessOwnershipResolver({ processes: [a, b], now: 100 }).resolve(100),
    ).toMatchObject({ classification: "unknown", strong: false });
    expect(
      createProcessOwnershipResolver({
        processes: [process({ pid: 102, ppid: 999 })],
        now: 100,
      }).resolve(102),
    ).toMatchObject({ classification: "external", strong: false });
  });

  it("refuses owned evidence when the ancestry is cyclic", () => {
    const pane = process({ pid: 100, ppid: 101 });
    const child = process({ pid: 101, ppid: 100 });
    expect(
      createProcessOwnershipResolver({
        processes: [pane, child],
        panes: [{ session: "worker-1", pane }],
        workOrders: [activeWorkOrder],
        leases: [activeLease],
        now: 100,
      }).resolve(101),
    ).toMatchObject({
      classification: "unknown",
      strong: false,
      evidence: ["invalid-process-ancestry"],
    });
  });

  it("resolveAll returns one ownership result for each input process in snapshot order", () => {
    const first = process({ pid: 100, command: "Safari" });
    const second = process({ pid: 101, command: "codex" });

    const ownership = createProcessOwnershipResolver({
      processes: [first, second],
      now: 100,
    }).resolveAll();

    expect(ownership).toHaveLength(2);
    expect(ownership.map((entry) => entry.process)).toEqual([first, second]);
  });
});

describe("process snapshot adapter", () => {
  it("normalizes supervisor registry and pool evidence without collapsing statuses", () => {
    expect(
      normalizeSupervisorWorkOrderEvidence([
        {
          workOrder: { id: "wo-1", workerSession: "worker-1" },
          state: { supervisorSession: "supervisor-1", status: "needs-revision" },
        },
      ]),
    ).toEqual([
      {
        id: "wo-1",
        workerSession: "worker-1",
        supervisorSession: "supervisor-1",
        status: "needs-revision",
      },
    ]);
    expect(
      normalizeSupervisorLeaseEvidence([
        {
          workOrderId: "wo-1",
          workerSession: "worker-1",
          status: "retained",
          retainUntil: 100,
        },
      ]),
    ).toEqual([
      {
        id: "wo-1:worker-1",
        workOrderId: "wo-1",
        supervisorSession: "worker-1",
        status: "retained",
        retainUntil: 100,
      },
    ]);
  });

  it("parses heterogeneous ps rows without splitting commands and skips invalid rows", () => {
    const rows = parseResourceProcessPs(`
      10 1 10 Sun Aug  9 10:00:00 2026 12.5 2048 node worker with spaces
      invalid row
      11 1 11 Mon Aug 10 11:00:00 2026 0.0 1 /bin/sh -c echo hello world
    `);
    expect(rows).toEqual([
      expect.objectContaining({
        pid: 10,
        ppid: 1,
        pgid: 10,
        cpuPct: 12.5,
        rssKb: 2048,
        command: "node worker with spaces",
      }),
      expect.objectContaining({ pid: 11, command: "/bin/sh -c echo hello world" }),
    ]);
  });

  it("rejects nonempty bulk ps output when every row is invalid but accepts mixed output", async () => {
    const invalid = createBulkResourceProcessProbe({
      exec: async () => ({ stdout: "not a ps row\n", stderr: "" }),
    });
    await expect(invalid()).rejects.toThrow("unable to parse process snapshot");
    const mixed = createBulkResourceProcessProbe({
      exec: async () => ({
        stdout: "not a ps row\n10 1 10 Sun Aug  9 10:00:00 2026 1.5 10 node worker\n",
        stderr: "",
      }),
    });
    await expect(mixed()).resolves.toMatchObject({
      processes: [expect.objectContaining({ pid: 10 })],
    });
  });

  it("runs exactly one bulk ps command per deep snapshot", async () => {
    const exec = vi.fn(async () => ({
      stdout: "10 1 10 Sun Aug  9 10:00:00 2026 12.5 2048 node worker\n",
      stderr: "",
    }));
    const probe = createBulkResourceProcessProbe({ exec, now: () => 100 });
    await expect(probe()).resolves.toMatchObject({
      capturedAt: 100,
      processes: [expect.any(Object)],
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      "ps",
      expect.arrayContaining(["-axo"]),
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: "C", LANG: "C" }) }),
    );
  });

  it("rejects a failed bulk ps probe instead of returning an empty valid snapshot", async () => {
    const probe = createBulkResourceProcessProbe({
      exec: async () => Promise.reject(new Error("ps timeout")),
    });
    await expect(probe()).rejects.toThrow("ps timeout");
  });

  it("calls cwdOf for fewer than all processes: only owned or explicitly shortlisted unknown candidates", async () => {
    const pane = process({ pid: 100 });
    const owned = process({ pid: 101, ppid: 100 });
    const unknown = process({ pid: 102, command: "codex --resume x" });
    const external = process({ pid: 103, command: "Safari", cpuPct: 99 });
    const cwdOf = vi.fn<(pid: number) => Promise<string>>(async (pid) => `/cwd/${pid}`);
    const collector = createProductionProcessOwnershipCollector({
      processProbe: async () => ({
        capturedAt: 100,
        thermal: "unknown",
        processes: [pane, owned, unknown, external],
      }),
      sessions: ["worker-1"],
      panePid: async () => 100,
      readWorkOrders: () => [activeWorkOrder],
      readLeases: () => [activeLease],
      introspector: { cwdOf },
      now: () => 100,
    });

    const result = await collector.collect();

    expect(cwdOf.mock.calls.length).toBeLessThan(result.snapshot.processes.length);
    expect(cwdOf).toHaveBeenCalledTimes(3);
    expect(cwdOf).toHaveBeenCalledWith(100);
    expect(cwdOf).toHaveBeenCalledWith(101);
    expect(cwdOf).toHaveBeenCalledWith(102);
    expect(cwdOf).not.toHaveBeenCalledWith(103);
    expect(result.snapshot.processes.find((entry) => entry.pid === 101)?.cwd).toBe("/cwd/101");
  });

  it("keeps cwd lookups CPU-sorted, capped, concurrent at two, and resilient to one failure", async () => {
    const pane = process({ pid: 100, cpuPct: 1 });
    const descendants = Array.from({ length: 20 }, (_, index) =>
      process({ pid: 101 + index, ppid: 100, cpuPct: 100 - index }),
    );
    const external = process({ pid: 999, command: "Safari", cpuPct: 1000 });
    let active = 0;
    let maxActive = 0;
    const cwdOf = vi.fn(async (pid: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (pid === 101) throw new Error("gone");
      return `/cwd/${pid}`;
    });
    const result = await createProductionProcessOwnershipCollector({
      processProbe: async () => ({
        capturedAt: 100,
        thermal: "unknown",
        processes: [pane, ...descendants, external],
      }),
      sessions: ["worker-1"],
      panePid: async () => 100,
      readWorkOrders: () => [activeWorkOrder],
      readLeases: () => [activeLease],
      introspector: { cwdOf },
      cwdLimit: 3,
      now: () => 100,
    }).collect();

    expect(cwdOf).toHaveBeenCalledTimes(3);
    expect(cwdOf.mock.calls.map(([pid]) => pid)).toEqual([101, 102, 103]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(cwdOf).not.toHaveBeenCalledWith(999);
    expect(result.snapshot.processes.find((entry) => entry.pid === 101)?.cwd).toBeUndefined();
  });

  it("rejects unstable pane ids observed around a snapshot", async () => {
    const pane = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    const panePids = vi
      .fn<() => Promise<readonly number[]>>()
      .mockResolvedValueOnce([100])
      .mockResolvedValueOnce([101]);
    const result = await createProductionProcessOwnershipCollector({
      processProbe: async () => ({ capturedAt: 100, thermal: "unknown", processes: [pane, child] }),
      sessions: ["worker-1"],
      panePid: async () => null,
      panePids: async () => panePids(),
      readWorkOrders: () => [activeWorkOrder],
      readLeases: () => [activeLease],
      introspector: { cwdOf: async () => null },
      now: () => 100,
    }).collect();

    expect(result.ownership.find((entry) => entry.process.pid === 101)).toMatchObject({
      classification: "unknown",
      strong: false,
      evidence: ["unstable-pane-pid"],
    });
  });

  it("reads launch evidence once and permits an exact launch-only path", async () => {
    const launcher = process({ pid: 100 });
    const child = process({ pid: 101, ppid: 100 });
    const readLaunches = vi.fn(() => [
      { process: launcher, session: "worker-1", workOrderId: "wo-1" },
    ]);
    const result = await createProductionProcessOwnershipCollector({
      processProbe: async () => ({
        capturedAt: 100,
        thermal: "unknown",
        processes: [launcher, child],
      }),
      sessions: [],
      panePid: async () => null,
      readWorkOrders: () => [activeWorkOrder],
      readLeases: () => [],
      readLaunches,
      introspector: { cwdOf: async () => null },
      now: () => 100,
    }).collect();

    expect(readLaunches).toHaveBeenCalledTimes(1);
    expect(result.ownership.find((entry) => entry.process.pid === 101)).toMatchObject({
      classification: "bot-active",
      strong: true,
    });
  });

  it("reads registry and lease state once for one supervisor snapshot", async () => {
    const pane = process({ pid: 100 });
    const readRegistry = vi.fn(() => ({
      records: [
        {
          workOrder: { id: "wo-1", workerSession: "worker-1" },
          state: { supervisorSession: "supervisor-1", status: "in-flight" as const },
        },
      ],
    }));
    const readLeaseState = vi.fn(() => ({
      leases: [{ workOrderId: "wo-1", workerSession: "worker-1", status: "active" as const }],
    }));
    const collector = createSupervisorProcessOwnershipCollector({
      processProbe: async () => ({ capturedAt: 100, thermal: "unknown", processes: [pane] }),
      sessions: ["worker-1"],
      panePid: async () => 100,
      readRegistry,
      readLeaseState,
      introspector: { cwdOf: async () => null },
      now: () => 100,
    });

    await collector.collect();

    expect(readRegistry).toHaveBeenCalledTimes(1);
    expect(readLeaseState).toHaveBeenCalledTimes(1);
  });
});
