import * as fs from "node:fs";
import * as os from "node:os";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatSingleConversation,
  getLatestAssistantReply,
  getRecentConversations,
  listClaudeSessions,
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

  it("prepends a leading slash when the path is relative (no leading /)", () => {
    // The relative-path branch: "relative/dir" is normalized to "/relative/dir"
    // before slashes become hyphens, so it gets a leading "-" like absolute paths.
    const result = projectPathToHistoryDir("relative/dir");
    expect(result).toBe(nodePath.join(homedir(), ".claude/projects", "-relative-dir"));
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

  it("skips a message whose content is neither string nor array (extractText fallback)", async () => {
    // content=42 → extractText returns "" → skipped; the following pair forms the round
    write("a.jsonl", [
      JSON.stringify({ type: "user", timestamp: "2026-06-10T10:00:00Z", message: { content: 42 } }),
      line("user", "real prompt"),
      line("assistant", "real answer"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("real prompt");
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

  it("skips a user turn that starts with the session-continuation prefix", async () => {
    write("a.jsonl", [
      line(
        "user",
        "This session is being continued from a previous conversation that ran out of context.",
      ),
      line("user", "actual question"),
      line("assistant", "actual answer"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("actual question");
  });

  it("skips a user turn that starts with Summary:", async () => {
    write("a.jsonl", [
      line("user", "Summary: context from before"),
      line("user", "real question"),
      line("assistant", "real answer"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("real question");
  });

  it("extracts slash command from <command-message> content", async () => {
    write("a.jsonl", [
      line("user", "<command-message>/simplify</command-message>"),
      line("assistant", "simplified"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds[0]?.user).toBe("[/simplify]");
  });

  it("extracts text from <command-message> without slash (returns inner text)", async () => {
    write("a.jsonl", [
      line("user", "<command-message>plain text without slash</command-message>"),
      line("assistant", "ok"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds[0]?.user).toBe("plain text without slash");
  });

  it("merges consecutive user messages with pipe separator (both plain text)", async () => {
    write("a.jsonl", [
      line("user", "first prompt"),
      line("user", "second prompt"),
      line("assistant", "answer"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toContain("first prompt");
    expect(rounds[0]?.user).toContain("second prompt");
  });

  it("merges a preceding command with following plain text (command → text)", async () => {
    write("a.jsonl", [
      line("user", "<command-name>/clear</command-name>"),
      line("user", "after clear message"),
      line("assistant", "cleared and responded"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toContain("[/clear]");
    expect(rounds[0]?.user).toContain("after clear message");
  });

  it("replaces a preceding command with a newer command (command → command)", async () => {
    write("a.jsonl", [
      line("user", "<command-name>/clear</command-name>"),
      line("user", "<command-name>/compact</command-name>"),
      line("assistant", "done"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("[/compact]");
  });

  it("advances past a non-user-assistant pair (assistant first, then user-assistant)", async () => {
    write("a.jsonl", [
      line("assistant", "orphan assistant"),
      line("user", "question"),
      line("assistant", "answer"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("question");
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

  it("returns [] when the history directory does not exist (readdir throws)", async () => {
    const rounds = await getRecentConversations("/no/such/project/at/all", configRoot);
    expect(rounds).toEqual([]);
  });

  it("skips transcript lines whose type is neither user nor assistant", async () => {
    write("a.jsonl", [
      JSON.stringify({ type: "system", message: { content: "system noise" } }),
      JSON.stringify({ type: "summary", message: { content: "a summary blob" } }),
      line("user", "the actual prompt"),
      line("assistant", "the actual answer"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("the actual prompt");
  });

  it("treats a content-array text item with no text field as empty (text ?? '')", async () => {
    // The assistant array item has type:text but no `text` key → String(undefined → "")
    // → the whole assistant turn extracts to "" → skipped, so no round forms.
    write("a.jsonl", [
      line("user", "prompt with array reply"),
      line("assistant", [{ type: "text" }]),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(0);
  });

  it("skips a whitespace-only user turn (parseUserInput returns null on empty)", async () => {
    write("a.jsonl", [
      line("user", "   "), // trims to "" → parseUserInput returns null → skipped
      line("user", "the genuine prompt"),
      line("assistant", "the reply"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("the genuine prompt");
  });

  it("skips a local-command-caveat wrapper user turn", async () => {
    write("a.jsonl", [
      line("user", "<local-command-caveat>caveat body</local-command-caveat>"),
      line("user", "actual user prompt"),
      line("assistant", "actual reply"),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("actual user prompt");
  });

  it("leaves the round time empty when the transcript line has no timestamp", async () => {
    // No timestamp field → rawTime is "" → the `time ?` branch yields "".
    write("a.jsonl", [
      JSON.stringify({ type: "user", message: { content: "no-timestamp prompt" } }),
      JSON.stringify({ type: "assistant", message: { content: "no-timestamp reply" } }),
    ]);
    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.time).toBe("");
  });

  it("getLatestAssistantReply returns null when the project dir has no transcripts", async () => {
    // historyDir exists (created in beforeEach) but contains no .jsonl files →
    // files.length === 0 → early null.
    const reply = await getLatestAssistantReply(projectPath, "anything at all", configRoot, 0);
    expect(reply).toBeNull();
  });

  it("getLatestAssistantReply returns null when the latest round has an empty assistant", async () => {
    // A user turn with no following assistant turn → no round pairs → latest is
    // undefined → `!latest?.assistant.trim()` is true → null.
    write("a.jsonl", [line("user", "a lonely prompt with no answer")]);
    const reply = await getLatestAssistantReply(
      projectPath,
      "a lonely prompt with no answer",
      configRoot,
      0,
    );
    expect(reply).toBeNull();
  });
});

describe("listClaudeSessions", () => {
  let configRoot: string;
  const projectPath = "/proj/sessions";
  let histDir: string;
  const UUID_A = "11111111-1111-1111-1111-111111111111";
  const UUID_B = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-sess-"));
    histDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(histDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(configRoot, { recursive: true, force: true }));

  it("returns [] when the project dir does not exist (readdir throws)", async () => {
    const sessions = await listClaudeSessions("/no/such/dir", configRoot);
    expect(sessions).toEqual([]);
  });

  it("lists only UUID-named .jsonl files, newest-first, and skips non-UUID / non-jsonl entries", async () => {
    // Two valid UUID transcripts (B written later → newer mtime), plus noise that
    // must be excluded: a non-UUID jsonl, a UUID-named .txt, and a subdirectory.
    fs.writeFileSync(nodePath.join(histDir, `${UUID_A}.jsonl`), "{}");
    fs.writeFileSync(nodePath.join(histDir, "not-a-uuid.jsonl"), "{}");
    fs.writeFileSync(nodePath.join(histDir, `${UUID_A}.txt`), "{}");
    fs.mkdirSync(nodePath.join(histDir, `${UUID_B}.jsonl-dir`), { recursive: true });
    // Make B clearly newer.
    fs.writeFileSync(nodePath.join(histDir, `${UUID_B}.jsonl`), "{}");
    const future = Date.now() + 60_000;
    fs.utimesSync(nodePath.join(histDir, `${UUID_B}.jsonl`), future / 1000, future / 1000);

    const sessions = await listClaudeSessions(projectPath, configRoot);
    expect(sessions.map((s) => s.sessionId)).toEqual([UUID_B, UUID_A]);
    expect(sessions[0]?.mtime).toBeInstanceOf(Date);
  });

  it("honors the limit argument", async () => {
    fs.writeFileSync(nodePath.join(histDir, `${UUID_A}.jsonl`), "{}");
    fs.writeFileSync(nodePath.join(histDir, `${UUID_B}.jsonl`), "{}");
    const sessions = await listClaudeSessions(projectPath, configRoot, 1);
    expect(sessions).toHaveLength(1);
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
