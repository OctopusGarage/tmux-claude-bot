import { describe, expect, it } from "vitest";
import { TmuxBridge } from "../src/core/session/tmux.js";

describe("TmuxBridge.sessionsCreatedAt", () => {
  it("parses 'name epoch' lines into a map of epoch-seconds", async () => {
    const bridge = new TmuxBridge({
      execFile: async () => ({
        stdout: "tmux_proj_a 1780000000\ntmux_proj_b 1781000000\n",
        stderr: "",
      }),
      getSessionName: async () => "tmux_proj_test",
    });
    const m = await bridge.sessionsCreatedAt();
    expect(m.get("tmux_proj_a")).toBe(1780000000);
    expect(m.get("tmux_proj_b")).toBe(1781000000);
  });

  it("returns an empty map when tmux fails", async () => {
    const bridge = new TmuxBridge({
      execFile: async () => {
        throw new Error("no server");
      },
      getSessionName: async () => "tmux_proj_test",
    });
    expect((await bridge.sessionsCreatedAt()).size).toBe(0);
  });

  it("skips lines with invalid or missing epoch", async () => {
    const bridge = new TmuxBridge({
      execFile: async () => ({
        stdout: "tmux_proj_a 1780000000\nbad_line\ntmux_proj_c \n",
        stderr: "",
      }),
      getSessionName: async () => "tmux_proj_test",
    });
    const m = await bridge.sessionsCreatedAt();
    expect(m.get("tmux_proj_a")).toBe(1780000000);
    expect(m.size).toBe(1);
  });

  it("returns empty map when stdout is empty", async () => {
    const bridge = new TmuxBridge({
      execFile: async () => ({ stdout: "", stderr: "" }),
      getSessionName: async () => "tmux_proj_test",
    });
    expect((await bridge.sessionsCreatedAt()).size).toBe(0);
  });
});
