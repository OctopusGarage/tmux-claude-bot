import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../src/core/deps.js";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("../../src/core/projects/sessionPathMap.js", () => ({ getPathBySession: () => null }));

import { captureScheduledTarget } from "../../src/core/scheduled-messages/target.js";

const deps = { config: { projectSessionPrefix: "managed_" } } as HandlerDeps;
describe("pinned tmux targets", () => {
  beforeEach(() => {
    execFile.mockClear();
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(null, { stdout: "managed_test\t100\t$1\t1234\t%2\n" }),
    );
  });
  it("uses literal argument arrays and exact session matching", async () => {
    const target = await captureScheduledTarget(deps, "managed_test");
    expect(target.incarnation).toBe("100:$1:1234:%2");
    expect(execFile.mock.calls[0]?.[1]).toEqual([
      "display-message",
      "-p",
      "-t",
      "=managed_test:0.0",
      "#{session_name}\t#{pid}\t#{session_id}\t#{session_created}\t#{pane_id}",
    ]);
  });
  it.each(["other_test", "managed_bad:1", "managed_bad.1", "managed_bad\n"])(
    "rejects unmanaged or target selectors: %s",
    async (name) => {
      await expect(captureScheduledTarget(deps, name)).rejects.toThrow();
      expect(execFile).not.toHaveBeenCalled();
    },
  );
  it("refuses partial name matches", async () => {
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(null, { stdout: "managed_test_other\t100\t$1\t1234\t%2" }),
    );
    await expect(captureScheduledTarget(deps, "managed_test")).rejects.toThrow();
  });
});
