import { describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../../src/core/deps.js";

const registryRead = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/loop/supervisor-state.js", () => ({
  readLoopSupervisorWorkOrderRegistry: registryRead,
}));

import { createRuntimeOverviewReaders } from "../../../src/core/dashboard/runtime-overview-production.js";

function emptyRegistry() {
  return {
    records: [],
    unfinished: [],
    terminal: [],
    abandoned: [],
    staleDispatching: [],
  };
}

describe("production Runtime Overview readers", () => {
  it("keeps synchronous artifact scans out of the two-second TUI refresh path", () => {
    registryRead.mockReset();
    registryRead.mockReturnValue(emptyRegistry());
    const deps = {} as HandlerDeps;

    createRuntimeOverviewReaders({ deps, now: 1_000, operatorSessionRunning: false }).workOrders();
    createRuntimeOverviewReaders({ deps, now: 3_000, operatorSessionRunning: false }).workOrders();
    createRuntimeOverviewReaders({ deps, now: 30_999, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(1);

    createRuntimeOverviewReaders({ deps, now: 31_000, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(2);

    createRuntimeOverviewReaders({ deps, now: 500, operatorSessionRunning: false }).workOrders();
    expect(registryRead).toHaveBeenCalledTimes(3);
  });
});
