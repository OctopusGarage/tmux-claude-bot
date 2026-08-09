import { describe, expect, it } from "vitest";
import { copyToClipboard } from "../src/core/platform/clipboard.js";

function deps(opts: {
  platform: string;
  env?: Record<string, string>;
  tools?: string[];
  failRunFor?: string[];
}) {
  const tools = new Set(opts.tools ?? []);
  const failingTools = new Set(opts.failRunFor ?? []);
  const calls: { cmd: string; args: string[]; input: string }[] = [];
  return {
    calls,
    runWith: async (cmd: string, args: string[], input: string) => {
      if (!tools.has(cmd)) throw new Error(`not found: ${cmd}`);
      calls.push({ cmd, args, input });
      if (failingTools.has(cmd)) throw new Error(`failed: ${cmd}`);
    },
    onPath: async (cmd: string) => tools.has(cmd),
    platform: opts.platform,
    env: opts.env ?? {},
  };
}

describe("copyToClipboard", () => {
  it("uses pbcopy on darwin", async () => {
    const d = deps({ platform: "darwin", tools: ["pbcopy"] });
    expect(await copyToClipboard("hi", d)).toBe(true);
    expect(d.calls[0]?.cmd).toBe("pbcopy");
    expect(d.calls[0]?.input).toBe("hi");
  });

  it("prefers wl-copy on Wayland Linux", async () => {
    const d = deps({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      tools: ["wl-copy", "xclip"],
    });
    expect(await copyToClipboard("hi", d)).toBe(true);
    expect(d.calls[0]?.cmd).toBe("wl-copy");
  });

  it("uses xclip on X11 Linux when wl-copy is absent", async () => {
    const d = deps({ platform: "linux", env: { DISPLAY: ":0" }, tools: ["xclip"] });
    expect(await copyToClipboard("hi", d)).toBe(true);
    expect(d.calls[0]).toEqual({
      cmd: "xclip",
      args: ["-selection", "clipboard"],
      input: "hi",
    });
  });

  it("falls back to xsel when only xsel is present", async () => {
    const d = deps({ platform: "linux", env: { DISPLAY: ":0" }, tools: ["xsel"] });
    expect(await copyToClipboard("hi", d)).toBe(true);
    expect(d.calls[0]?.cmd).toBe("xsel");
  });

  it("returns false on headless Linux (no tool)", async () => {
    const d = deps({ platform: "linux", env: {}, tools: [] });
    expect(await copyToClipboard("hi", d)).toBe(false);
    expect(d.calls).toHaveLength(0);
  });

  it("does not invoke display-bound Linux tools when their display is unavailable", async () => {
    const d = deps({ platform: "linux", env: {}, tools: ["wl-copy", "xclip", "xsel"] });

    expect(await copyToClipboard("hi", d)).toBe(true);

    expect(d.calls).toEqual([{ cmd: "xsel", args: ["--clipboard", "--input"], input: "hi" }]);
  });

  it("returns false when the selected clipboard tool fails", async () => {
    const d = deps({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      tools: ["wl-copy", "xsel"],
      failRunFor: ["wl-copy"],
    });

    expect(await copyToClipboard("hi", d)).toBe(false);
    expect(d.calls.map((call) => call.cmd)).toEqual(["wl-copy"]);
  });
});
