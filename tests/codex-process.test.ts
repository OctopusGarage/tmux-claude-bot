import { describe, expect, it } from "vitest";
import { isCodexProcess } from "../src/core/agents/codex/codex-process.js";

describe("isCodexProcess", () => {
  it("matches the bare codex binary", () => {
    expect(isCodexProcess("codex --yolo")).toBe(true);
  });
  it("matches an absolute path to codex", () => {
    expect(isCodexProcess("/opt/homebrew/bin/codex resume abc")).toBe(true);
  });
  it("matches a codex-* wrapper script as argv0", () => {
    expect(isCodexProcess("codex-stella")).toBe(true);
  });
  it("does not match codex mentioned only in an argument", () => {
    expect(isCodexProcess("vim codex.ts")).toBe(false);
    expect(isCodexProcess("node build-codex.js")).toBe(false);
  });
  it("does not match claude", () => {
    expect(isCodexProcess("claude --dangerously-skip-permissions")).toBe(false);
  });
  it("handles empty input", () => {
    expect(isCodexProcess("")).toBe(false);
  });
});
