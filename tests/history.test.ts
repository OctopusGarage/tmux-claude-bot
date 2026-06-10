import * as fs from "node:fs";
import * as os from "node:os";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatSingleConversation,
  getLatestAssistantReply,
  getRecentConversations,
  projectPathToHistoryDir,
} from "../src/core/history.js";

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

describe("parseConversationRounds (via getRecentConversations)", () => {
  let configRoot: string;
  const projectPath = "/proj/test";
  let histDir: string;

  const line = (
    type: "user" | "assistant",
    content: unknown,
    extra: Record<string, unknown> = {},
  ): string =>
    JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content }, ...extra });

  beforeEach(() => {
    configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-hist-"));
    histDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(histDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(configRoot, { recursive: true, force: true }));

  const write = (name: string, lines: string[]): void =>
    fs.writeFileSync(nodePath.join(histDir, name), `${lines.join("\n")}\n`, "utf-8");

  it("pairs user → assistant into a round", async () => {
    write("a.jsonl", [line("user", "hello world test"), line("assistant", "hi there")]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ user: "hello world test", assistant: "hi there" });
  });

  it("skips malformed JSON lines and isMeta lines", async () => {
    write("a.jsonl", [
      "{ not valid json",
      line("user", "real prompt here", { isMeta: true }), // meta → skipped
      line("user", "actual prompt"),
      line("assistant", "the answer"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("actual prompt");
  });

  it("collapses an agentic trace (tool_result has no text) to the final assistant block", async () => {
    write("a.jsonl", [
      line("user", "do the thing"),
      line("assistant", "let me call a tool"),
      line("user", [{ type: "tool_result", content: "output" }]), // no text → skipped
      line("assistant", "final conclusion"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.assistant).toBe("final conclusion");
  });

  it("extracts a slash command name from a user turn", async () => {
    write("a.jsonl", [
      line("user", "<command-name>/clear</command-name>"),
      line("assistant", "cleared"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds[0]?.user).toBe("[/clear]");
  });

  it("extracts text from a content-array message", async () => {
    write("a.jsonl", [
      line("user", "array prompt content"),
      line("assistant", [{ type: "text", text: "array answer" }]),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds[0]?.assistant).toBe("array answer");
  });

  it("getLatestAssistantReply matches the sent prompt exactly", async () => {
    write("a.jsonl", [line("user", "what is 2+2"), line("assistant", "4")]);
    const reply = await getLatestAssistantReply(projectPath, "what is 2+2", configRoot, 0);
    expect(reply).toBe("4");
  });

  it("getLatestAssistantReply fuzzy-matches when the sent text contains the stored prompt", async () => {
    write("a.jsonl", [line("user", "summarize the file"), line("assistant", "summary done")]);
    const reply = await getLatestAssistantReply(
      projectPath,
      "please summarize the file now",
      configRoot,
      0,
    );
    expect(reply).toBe("summary done");
  });

  it("getLatestAssistantReply returns null when nothing matches", async () => {
    write("a.jsonl", [line("user", "unrelated prompt"), line("assistant", "x")]);
    const reply = await getLatestAssistantReply(projectPath, "totally different", configRoot, 0);
    expect(reply).toBeNull();
  });

  it("getLatestAssistantReply fuzzy-matches when the stored prompt contains the sent text", async () => {
    // Second fuzzy branch: userText.includes(normalizedSent), not the other way around.
    // Store a long prompt; sent text is a substring of the stored prompt.
    write("a.jsonl", [
      line("user", "please summarize the entire long document for me"),
      line("assistant", "summary here"),
    ]);
    const reply = await getLatestAssistantReply(
      projectPath,
      "summarize the entire long document",
      configRoot,
      0,
    );
    expect(reply).toBe("summary here");
  });

  it("getLatestAssistantReply returns null when the history file cannot be read", async () => {
    // Write a directory with the .jsonl name so fs.readFile fails.
    const histDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(nodePath.join(histDir, "unreadable.jsonl"), { recursive: true });
    const reply = await getLatestAssistantReply(projectPath, "anything", configRoot, 0);
    expect(reply).toBeNull();
  });

  it("getRecentConversations skips unreadable history files", async () => {
    // One readable file and one that's actually a directory (read will throw).
    write("readable.jsonl", [line("user", "real question"), line("assistant", "real answer")]);
    const histDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(nodePath.join(histDir, "unreadable.jsonl"), { recursive: true });
    const rounds = await getRecentConversations(projectPath, configRoot);
    // readable.jsonl produces one round; unreadable.jsonl is skipped.
    expect(rounds.length).toBeGreaterThanOrEqual(1);
    expect(rounds.some((r) => r.user === "real question")).toBe(true);
  });
});

describe("formatSingleConversation", () => {
  it("formats a round with index and totals for telegram", () => {
    const round = { user: "hello", assistant: "world", time: "10:00", file: "a.jsonl" };
    const text = formatSingleConversation(round, 0, 3, "telegram");
    expect(text).toContain("[1/3]");
    expect(text).toContain("hello");
    expect(text).toContain("world");
    expect(text).toContain("🤖 Claude");
  });

  it("defaults to telegram channel", () => {
    const round = { user: "q", assistant: "a", time: "10:00", file: "b.jsonl" };
    const text = formatSingleConversation(round, 1, 2);
    expect(text).toContain("[2/2]");
  });
});
