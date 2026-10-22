import { describe, expect, it, vi } from "vitest";
import { createBulkPaneSnapshotProbe } from "../../src/core/resource-guardian/pane-snapshot.js";

describe("bulk pane snapshot", () => {
  it("reads all panes once and preserves session boundaries and stable PID ordering", async () => {
    const exec = vi.fn(async () => ({ stdout: "worker\t20\nother\t30\nworker\t10\n", stderr: "" }));
    const snapshot = await createBulkPaneSnapshotProbe({ exec })();

    expect([...snapshot]).toEqual([
      ["worker", [10, 20]],
      ["other", [30]],
    ]);
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "tmux",
      ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    );
  });

  it.each([
    "garbage",
    "worker\t0",
    "worker\t-1",
    "worker\t9007199254740992",
    "\t10",
    "worker\t10\nmalformed",
  ])("rejects malformed observation %j", async (stdout) => {
    await expect(
      createBulkPaneSnapshotProbe({ exec: async () => ({ stdout, stderr: "" }) })(),
    ).rejects.toThrow("invalid tmux pane snapshot");
  });

  it("does not turn a failed command into a valid empty roster", async () => {
    await expect(
      createBulkPaneSnapshotProbe({
        exec: async () => {
          throw new Error("tmux timeout");
        },
      })(),
    ).rejects.toThrow("tmux timeout");
  });

  it("accepts an empty successful observation", async () => {
    expect(
      (await createBulkPaneSnapshotProbe({ exec: async () => ({ stdout: "", stderr: "" }) })())
        .size,
    ).toBe(0);
  });
});
