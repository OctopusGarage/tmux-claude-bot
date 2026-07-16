import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { startKeepAwake, stopKeepAwake } from "../../src/core/platform/keep-awake.js";

const fakeChild = () => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return undefined;
    }),
    kill: vi.fn(),
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  };
};
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

  it("allows a later retry when spawning caffeinate throws", () => {
    setPlatform("darwin");
    const child = fakeChild();
    spawnMock.mockImplementationOnce(() => {
      throw new Error("caffeinate missing");
    });
    spawnMock.mockReturnValueOnce(child);

    startKeepAwake(true);
    startKeepAwake(true);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.on).toHaveBeenCalledWith("exit", expect.any(Function));
  });

  it("allows a later retry after the caffeinate child emits error", () => {
    setPlatform("darwin");
    const first = fakeChild();
    const second = fakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    startKeepAwake(true);
    first.emit("error", new Error("spawn failed"));
    startKeepAwake(true);

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("allows a later retry after the caffeinate child exits", () => {
    setPlatform("darwin");
    const first = fakeChild();
    const second = fakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    startKeepAwake(true);
    first.emit("exit");
    startKeepAwake(true);

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
