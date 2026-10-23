import { describe, expect, it, vi } from "vitest";
import { TmuxBridge } from "../../src/core/session/tmux.js";

describe("pinned scheduled submission", () => {
  const fixture = (replacedAt?: number) => {
    let writes = 0;
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "if-shell") {
        writes++;
        if (writes === replacedAt) return { stdout: "TCB_TARGET_REPLACED\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const bridge = new TmuxBridge({
      getSessionName: async () => "reusable",
      execFile: exec,
      writeFile: async () => {},
      unlinkFile: async () => {},
      sleep: async () => {},
    });
    return { bridge, exec };
  };
  it("guards both paste and Enter within the server connection and uses only the pinned pane", async () => {
    const { bridge, exec } = fixture();
    await bridge.sendKeysToPinnedPane("line one\nline two", { paneId: "%12", serverPid: "100" });
    const guarded = exec.mock.calls.filter(([, args]) => args[0] === "if-shell");
    expect(guarded).toHaveLength(2);
    expect(guarded[0]?.[1]).toEqual([
      "if-shell",
      "-F",
      "#{==:#{pid},100}",
      expect.stringMatching(/^paste-buffer -p -b tcb-send-.* -t %12$/),
      "display-message -p TCB_TARGET_REPLACED",
    ]);
    expect(guarded[1]?.[1]).toEqual([
      "if-shell",
      "-F",
      "#{==:#{pid},100}",
      "send-keys -t %12 C-m",
      "display-message -p TCB_TARGET_REPLACED",
    ]);
    expect(JSON.stringify(exec.mock.calls)).not.toContain("reusable");
  });
  it("does not submit when a replacement server is observed before paste", async () => {
    const { bridge, exec } = fixture(1);
    await expect(
      bridge.sendKeysToPinnedPane("text", { paneId: "%12", serverPid: "100" }),
    ).rejects.toThrow("replaced");
    expect(exec.mock.calls.filter(([, args]) => args[0] === "if-shell")).toHaveLength(1);
  });
  it("rechecks server ownership before Enter after paste", async () => {
    const { bridge, exec } = fixture(2);
    await expect(
      bridge.sendKeysToPinnedPane("text", { paneId: "%12", serverPid: "100" }),
    ).rejects.toThrow("replaced");
    expect(exec.mock.calls.filter(([, args]) => args[0] === "if-shell")).toHaveLength(2);
  });
  it.each([
    { paneId: "%12; kill-server", serverPid: "100" },
    { paneId: "%12", serverPid: "100; kill-server" },
  ])("rejects selectors that cannot be safe tmux command tokens", async (target) => {
    const { bridge, exec } = fixture();
    await expect(bridge.sendKeysToPinnedPane("text", target)).rejects.toThrow("Invalid pinned");
    expect(exec).not.toHaveBeenCalled();
  });
});
