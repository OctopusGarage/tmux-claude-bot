import { describe, expect, it } from "vitest";
import { deriveStartLabel, parseStartCommands } from "../src/shared/config.js";

describe("deriveStartLabel", () => {
  it("prefers the CLAUDE_CONFIG_DIR folder name", () => {
    expect(deriveStartLabel("CLAUDE_CONFIG_DIR=~/.claude-stella /bin/claude --flag", 1)).toBe(
      "claude-stella",
    );
  });

  it("falls back to ANTHROPIC_MODEL", () => {
    expect(deriveStartLabel("ANTHROPIC_MODEL=claude-opus-4-8 claude", 1)).toBe("claude-opus-4-8");
  });

  it("falls back to the binary basename", () => {
    expect(deriveStartLabel("/home/user/.local/bin/claude --dangerously-skip-permissions", 1)).toBe(
      "claude",
    );
  });

  it("uses #idx when nothing distinguishes the command", () => {
    expect(deriveStartLabel("FOO=bar", 3)).toBe("#3");
  });
});

describe("parseStartCommands", () => {
  it("returns just the primary when no numbered vars are set", () => {
    expect(parseStartCommands({}, "claude-yolo")).toEqual([
      { label: "claude-yolo", command: "claude-yolo" },
    ]);
  });

  it("collects contiguous CLAUDE_START_COMMAND_2..N after the primary", () => {
    const env = {
      CLAUDE_START_COMMAND_2: "ANTHROPIC_MODEL=opus claude",
      CLAUDE_START_COMMAND_3: "claude-x",
    } as NodeJS.ProcessEnv;
    expect(parseStartCommands(env, "claude-yolo").map((c) => c.command)).toEqual([
      "claude-yolo",
      "ANTHROPIC_MODEL=opus claude",
      "claude-x",
    ]);
  });

  it("honors an explicit CLAUDE_START_LABEL_n over the derived label", () => {
    const env = {
      CLAUDE_START_COMMAND_2: "claude-x",
      CLAUDE_START_LABEL_2: "工作号",
    } as NodeJS.ProcessEnv;
    expect(parseStartCommands(env, "claude-yolo")[1]).toEqual({
      label: "工作号",
      command: "claude-x",
    });
  });

  it("stops at the first gap (ignores _4 when _3 is missing)", () => {
    const env = {
      CLAUDE_START_COMMAND_2: "a",
      CLAUDE_START_COMMAND_4: "c",
    } as NodeJS.ProcessEnv;
    expect(parseStartCommands(env, "p").map((c) => c.command)).toEqual(["p", "a"]);
  });
});
