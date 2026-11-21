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

  it.each([
    ["private-session", "field-count"],
    ["private-session\t10\textra-secret", "field-count"],
    ["\t10", "empty-session"],
    ["private-session\t-1", "invalid-pid"],
    ["private-session\t9007199254740992", "unsafe-pid"],
  ])("reports only a fixed validation category for malformed rows", async (row, reason) => {
    const error = await createBulkPaneSnapshotProbe({
      exec: async () => ({ stdout: `valid\t10\n${row}\n`, stderr: "" }),
    })().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`invalid tmux pane snapshot: row=2 reason=${reason}`);
    expect((error as Error).message).not.toMatch(/private-session|extra-secret/);
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
