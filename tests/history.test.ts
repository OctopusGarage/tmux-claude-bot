import { homedir } from "node:os";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { projectPathToHistoryDir } from "../src/core/history.js";

describe("projectPathToHistoryDir", () => {
  it("converts slashes and underscores to hyphens to match Claude's actual behavior", () => {
    const result = projectPathToHistoryDir("/Users/test/project");
    expect(result).toBe(nodePath.join(homedir(), ".claude/projects", "-Users-test-project"));
  });

  it("converts underscores to hyphens (Claude behavior)", () => {
    const result = projectPathToHistoryDir("/Users/test/social_media_posts");
    expect(result).toBe(
      nodePath.join(homedir(), ".claude/projects", "-Users-test-social-media-posts"),
    );
  });

  it("preserves hyphens in directory names", () => {
    const result = projectPathToHistoryDir("/Users/test/tmux-claude-bot");
    expect(result).toBe(
      nodePath.join(homedir(), ".claude/projects", "-Users-test-tmux-claude-bot"),
    );
  });

  it("converts both slashes and underscores to hyphens", () => {
    const result = projectPathToHistoryDir("/Users/test/social_media_posts");
    expect(result).not.toContain("social/media/posts");
    expect(result).not.toContain("social_media_posts");
    expect(result).toContain("social-media-posts");
  });

  it("handles nested paths with underscores correctly", () => {
    const result = projectPathToHistoryDir("/Users/test/entropy-nexus/social_media_posts");
    expect(result).toBe(
      nodePath.join(homedir(), ".claude/projects", "-Users-test-entropy-nexus-social-media-posts"),
    );
  });
});
