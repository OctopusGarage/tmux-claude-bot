import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { startKeepAwake, stopKeepAwake } from "../../src/core/platform/keep-awake.js";

const fakeChild = () => ({ on: vi.fn(), kill: vi.fn() });
const origPlatform = process.platform;
const setPlatform = (p: string): void => {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
};

describe("keep-awake", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeChild());
  });
  afterEach(() => {
    stopKeepAwake(); // reset the module-level handle between cases
    setPlatform(origPlatform);
  });

  it("does nothing when disabled, even on macOS", () => {
    setPlatform("darwin");
    startKeepAwake(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does nothing off macOS, even when enabled", () => {
    setPlatform("linux");
    startKeepAwake(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns caffeinate -i -s -w <pid> once on macOS when enabled", () => {
    setPlatform("darwin");
    startKeepAwake(true);
    startKeepAwake(true); // already running -> no second process
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "caffeinate",
      ["-i", "-s", "-w", String(process.pid)],
      expect.anything(),
    );
  });

  it("stopKeepAwake terminates the child", () => {
    setPlatform("darwin");
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    startKeepAwake(true);
    stopKeepAwake();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
