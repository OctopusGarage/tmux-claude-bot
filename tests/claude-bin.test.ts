import { describe, expect, it } from "vitest";
import { claudeBinFromStartCommand } from "../src/shared/config.js";

describe("claudeBinFromStartCommand", () => {
  it("skips leading VAR=value env assignments and returns the real binary", () => {
    expect(
      claudeBinFromStartCommand(
        "CLAUDE_CONFIG_DIR=/home/u/.claude-stella /home/u/.local/bin/claude --flag",
      ),
    ).toBe("/home/u/.local/bin/claude");
  });

  it("returns a bare command unchanged", () => {
    expect(claudeBinFromStartCommand("claude --dangerously-skip-permissions")).toBe("claude");
  });

  it("returns an absolute path command", () => {
    expect(claudeBinFromStartCommand("/usr/bin/claude")).toBe("/usr/bin/claude");
  });

  it("skips multiple env assignments", () => {
    expect(claudeBinFromStartCommand("A=1 B=2 claude")).toBe("claude");
  });

  it("falls back to 'claude' for an all-assignment / empty command", () => {
    expect(claudeBinFromStartCommand("")).toBe("claude");
    expect(claudeBinFromStartCommand("FOO=bar")).toBe("claude");
  });
});
