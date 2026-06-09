import { describe, expect, it } from "vitest";
import { projectLabel } from "../src/adapters/telegram/project-label.js";

describe("projectLabel", () => {
  it("uses the basename of the mapped project path", () => {
    expect(
      projectLabel(
        "tmux_proj_-Users-x-programming-tmux-claude-bot",
        "/Users/x/programming/tmux-claude-bot",
      ),
    ).toBe("tmux-claude-bot");
  });

  it("trims a trailing slash before taking the basename", () => {
    expect(projectLabel("tmux_proj_-Users-x-app", "/Users/x/app/")).toBe("app");
  });

  it("falls back to a short id when no path is mapped", () => {
    const label = projectLabel("tmux_proj_-Users-x-app", undefined);
    expect(label.startsWith("#")).toBe(true);
    expect(label.length).toBeGreaterThan(1);
  });

  it("is stable for the same session", () => {
    expect(projectLabel("tmux_proj_-a", undefined)).toBe(projectLabel("tmux_proj_-a", undefined));
  });
});
