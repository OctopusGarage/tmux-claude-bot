import { describe, expect, it } from "vitest";
import { currentTmuxSession } from "../../src/cli/control.js";

describe("currentTmuxSession", () => {
  it("returns the session name from the injected runner", () => {
    expect(currentTmuxSession(() => "tmux_proj_abc\n")).toBe("tmux_proj_abc");
  });
  it("returns null when not under tmux (runner throws)", () => {
    expect(
      currentTmuxSession(() => {
        throw new Error("no server");
      }),
    ).toBeNull();
  });
});
