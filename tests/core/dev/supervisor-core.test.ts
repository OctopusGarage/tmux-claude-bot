import { describe, expect, it } from "vitest";
import {
  buildStatus,
  decideGate,
  nextCrashAction,
  shouldTriggerReload,
} from "../../../src/core/dev/supervisor-core.js";

describe("shouldTriggerReload", () => {
  it("triggers for source .ts files", () => {
    expect(shouldTriggerReload("core/projects/project-manager.ts")).toBe(true);
    expect(shouldTriggerReload("cli.ts")).toBe(true);
  });
  it("ignores non-TS and test files", () => {
    expect(shouldTriggerReload("docs/manual.md")).toBe(false);
    expect(shouldTriggerReload("core/foo.test.ts")).toBe(false);
    expect(shouldTriggerReload("core/__tests__/foo.ts")).toBe(false);
  });
});

describe("decideGate", () => {
  it("reloads on a clean typecheck, holds otherwise", () => {
    expect(decideGate(0)).toBe("reload");
    expect(decideGate(1)).toBe("hold");
    expect(decideGate(2)).toBe("hold");
  });
});

describe("nextCrashAction", () => {
  const cfg = { windowMs: 10_000, maxInWindow: 3, delayMs: 500 };
  it("respawns when crashes are under the burst limit", () => {
    expect(nextCrashAction([], 10_000, cfg)).toEqual({ action: "respawn", delayMs: 500 });
    expect(nextCrashAction([9_000, 9_500], 10_000, cfg)).toEqual({
      action: "respawn",
      delayMs: 500,
    });
  });
  it("waits when too many crashes fall inside the window", () => {
    expect(nextCrashAction([2_000, 3_000, 4_000], 10_000, cfg)).toEqual({ action: "wait" });
  });
  it("ignores crashes older than the window", () => {
    expect(nextCrashAction([100, 200, 300], 20_000, cfg)).toEqual({
      action: "respawn",
      delayMs: 500,
    });
  });
});

describe("buildStatus", () => {
  it("stamps updatedAtMs", () => {
    const s = buildStatus({ state: "running", lastReloadAtMs: 5, lastError: null }, 42);
    expect(s).toEqual({
      state: "running",
      lastReloadAtMs: 5,
      lastError: null,
      updatedAtMs: 42,
    });
  });
});
