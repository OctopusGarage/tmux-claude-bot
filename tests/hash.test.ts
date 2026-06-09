import { describe, expect, it } from "vitest";
import { sessionShortId } from "../src/utils/hash.js";

const BASE62_REGEX = /^[0-9a-zA-Z]{6}$/;

describe("sessionShortId", () => {
  it("returns exactly 6 characters", () => {
    const id = sessionShortId("tmux_proj_-Users-test-project");
    expect(id).toHaveLength(6);
  });

  it("contains only base62 characters", () => {
    const id = sessionShortId("tmux_proj_-Users-test-project");
    expect(BASE62_REGEX.test(id)).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const input = "tmux_proj_-Users-test-project";
    const a = sessionShortId(input);
    const b = sessionShortId(input);
    expect(a).toBe(b);
  });

  it("produces different outputs for different inputs", () => {
    const a = sessionShortId("tmux_proj_-Users-test-project-a");
    const b = sessionShortId("tmux_proj_-Users-test-project-b");
    expect(a).not.toBe(b);
  });

  it("handles empty string", () => {
    const id = sessionShortId("");
    expect(id).toHaveLength(6);
    expect(BASE62_REGEX.test(id)).toBe(true);
  });

  it("handles long session names", () => {
    const longName = `tmux_proj_-${"a".repeat(200)}`;
    const id = sessionShortId(longName);
    expect(id).toHaveLength(6);
    expect(BASE62_REGEX.test(id)).toBe(true);
  });
});
