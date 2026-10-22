import { describe, expect, it, vi } from "vitest";
import {
  runRemoteBranchCommand,
  runRemoteBranchGit,
} from "../../src/core/loop/remote-branch-process.js";

const invocation = { kind: "pr" as const, cwd: process.cwd(), env: {} };

describe("bounded remote maintenance processes", () => {
  it("lets the event loop progress before a slow command completes", async () => {
    let responsive = false;
    let completed = false;
    const tick = new Promise<void>((resolve) =>
      setTimeout(() => {
        responsive = true;
        resolve();
      }, 0),
    );
    const running = runRemoteBranchCommand({ ...invocation, command: "sleep 0.1" }).then(
      (result) => {
        completed = true;
        return result;
      },
    );
    await tick;
    expect(responsive).toBe(true);
    expect(completed).toBe(false);
    expect(await running).toMatchObject({ status: 0 });
  });

  it("terminates a stalled command within its explicit deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let completed = false;
      const running = runRemoteBranchCommand({ ...invocation, command: "sleep 60" }, 30).then(
        (result) => {
          completed = true;
          return result;
        },
      );
      await vi.advanceTimersByTimeAsync(29);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toEqual({
        status: 124,
        stdout: "",
        stderr: "remote branch command timed out",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed if the configured directory disappears before spawn", async () => {
    expect(
      await runRemoteBranchCommand({
        ...invocation,
        cwd: "/nonexistent-synthetic-remote-directory",
        command: "true",
      }),
    ).toEqual({ status: 1, stdout: "", stderr: "remote branch command could not start" });
  });

  it("bounds output and fails closed", async () => {
    const result = await runRemoteBranchCommand({ ...invocation, command: "yes synthetic-output" });
    expect(result).toEqual({
      status: 1,
      stdout: "",
      stderr: "remote branch command output limit exceeded",
    });
  });

  it("preserves exit status, output, working directory and command-local environment", async () => {
    const result = await runRemoteBranchCommand({
      ...invocation,
      env: { TCB_TEST_REMOTE_VALUE: "synthetic" },
      command: 'printf "%s" "$TCB_TEST_REMOTE_VALUE"; exit 7',
    });
    expect(result).toEqual({ status: 7, stdout: "synthetic", stderr: "" });
    expect(
      await runRemoteBranchGit({ cwd: process.cwd(), args: ["rev-parse", "--show-toplevel"] }),
    ).toMatchObject({ status: 0, stdout: `${process.cwd()}\n` });
  });
});
