import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getLatestCodexReply,
  getRecentCodexConversations,
  listCodexSessions,
  parseCodexRounds,
} from "../src/core/agents/codex/codex-history.js";

const ROLLOUT = [
  `{"timestamp":"t1","type":"session_meta","payload":{"id":"abc","cwd":"/home/user/proj"}}`,
  `{"timestamp":"t2","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"给个仓库描述"}]}}`,
  `{"timestamp":"t3","type":"response_item","payload":{"type":"reasoning","role":null,"content":{}}}`,
  `{"timestamp":"t4","type":"response_item","payload":{"type":"function_call","payload":{}}}`,
  `{"timestamp":"t5","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"这是描述。"}]}}`,
].join("\n");

describe("parseCodexRounds", () => {
  it("pairs user input_text with assistant output_text, skipping reasoning/tool items", () => {
    const rounds = parseCodexRounds(ROLLOUT);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("给个仓库描述");
    expect(rounds[0]?.assistant).toBe("这是描述。");
  });

  it("returns [] for empty / garbage input", () => {
    expect(parseCodexRounds("")).toEqual([]);
    expect(parseCodexRounds("not json\n{bad")).toEqual([]);
  });

  it("accumulates multiple assistant messages within one round", () => {
    const r = parseCodexRounds(
      [
        `{"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi there friend"}]}}`,
        `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"part1"}]}}`,
        `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"part2"}]}}`,
      ].join("\n"),
    );
    expect(r[0]?.assistant).toBe("part1\npart2");
  });

  it("keeps an assistant message that arrives before any user turn (not dropped)", () => {
    // File starts with an assistant/system message (no preceding user round). It
    // must surface as its own anonymous round, not be silently dropped.
    const r = parseCodexRounds(
      [
        `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"orphan reply"}]}}`,
        `{"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"a real question"}]}}`,
        `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"a real answer"}]}}`,
      ].join("\n"),
    );
    expect(r).toHaveLength(2);
    expect(r[0]?.user).toBe("");
    expect(r[0]?.assistant).toBe("orphan reply");
    expect(r[1]?.user).toBe("a real question");
    expect(r[1]?.assistant).toBe("a real answer");
  });

  it("does not merge an assistant reply into the prior round when the user turn was filtered (empty text)", () => {
    // The second user turn has no input_text (filtered to empty). Its assistant
    // reply must NOT bleed into the first round — it opens its own anonymous round.
    const r = parseCodexRounds(
      [
        `{"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first question"}]}}`,
        `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first answer"}]}}`,
        `{"payload":{"type":"message","role":"user","content":[{"type":"input_image","text":""}]}}`,
        `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"second answer"}]}}`,
      ].join("\n"),
    );
    expect(r).toHaveLength(2);
    expect(r[0]?.user).toBe("first question");
    expect(r[0]?.assistant).toBe("first answer"); // not "first answer\nsecond answer"
    expect(r[1]?.user).toBe("");
    expect(r[1]?.assistant).toBe("second answer");
  });
});

describe("getLatestCodexReply", () => {
  function writeRollout(): string {
    const root = fs.mkdtempSync(join(os.tmpdir(), "codex-home-"));
    const dir = join(root, "sessions", "2026", "06", "11");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "rollout-x.jsonl"), ROLLOUT);
    return root;
  }

  it("returns the reply for the matching sent text from the newest cwd-matched rollout", async () => {
    const root = writeRollout();
    const reply = await getLatestCodexReply(root, "/home/user/proj", "给个仓库描述", null, 0, 0);
    expect(reply).toBe("这是描述。");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null when sentText does not match the latest round (stale-reply guard)", async () => {
    const root = writeRollout();
    const reply = await getLatestCodexReply(
      root,
      "/home/user/proj",
      "an unrelated longer message",
      null,
      0,
      0,
    );
    expect(reply).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no rollout matches the project cwd", async () => {
    const root = writeRollout();
    const reply = await getLatestCodexReply(root, "/nope", "给个仓库描述", null, 0, 0);
    expect(reply).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses an explicit rolloutPath over the newest cwd-matched rollout (same-cwd contention)", async () => {
    const root = writeRollout(); // rollout-x.jsonl → "这是描述。"
    const dir = join(root, "sessions", "2026", "06", "11");
    // A SECOND session in the SAME cwd, written more recently, with a different
    // reply — the cwd+mtime scan would pick this one (newer), which would be wrong
    // when the user is actually talking to the first session.
    const newer = join(dir, "rollout-newer.jsonl");
    fs.writeFileSync(
      newer,
      [
        `{"type":"session_meta","payload":{"id":"def","cwd":"/home/user/proj"}}`,
        `{"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"给个仓库描述"}]}}`,
        `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"WRONG SESSION"}]}}`,
      ].join("\n"),
    );
    fs.utimesSync(newer, 9_000_000, 9_000_000); // make it the newest by mtime

    const live = join(dir, "rollout-x.jsonl"); // the session the user is in
    const reply = await getLatestCodexReply(root, "/home/user/proj", "给个仓库描述", live, 0, 0);
    expect(reply).toBe("这是描述。"); // the explicit rollout, NOT the newer one
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("getRecentCodexConversations", () => {
  const MULTI = [
    `{"timestamp":"t1","type":"session_meta","payload":{"id":"abc","cwd":"/home/user/proj"}}`,
    `{"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first question"}]}}`,
    `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first answer"}]}}`,
    `{"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second question"}]}}`,
    `{"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"second answer"}]}}`,
  ].join("\n");

  function writeRollout(text = MULTI): string {
    const root = fs.mkdtempSync(join(os.tmpdir(), "codex-home-"));
    const dir = join(root, "sessions", "2026", "06", "11");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, "rollout-x.jsonl"), text);
    return root;
  }

  it("returns rounds newest-first from the cwd-matched rollout", async () => {
    const root = writeRollout();
    const rounds = await getRecentCodexConversations(root, "/home/user/proj");
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.user).toBe("second question");
    expect(rounds[0]?.assistant).toBe("second answer");
    expect(rounds[1]?.user).toBe("first question");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("honours the limit, keeping the most recent rounds", async () => {
    const root = writeRollout();
    const rounds = await getRecentCodexConversations(root, "/home/user/proj", 1);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.user).toBe("second question");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns [] when no rollout matches the project cwd", async () => {
    const root = writeRollout();
    expect(await getRecentCodexConversations(root, "/nope")).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("listCodexSessions", () => {
  function meta(id: string, cwd: string): string {
    return JSON.stringify({ type: "session_meta", payload: { type: "session_meta", id, cwd } });
  }

  function setup(): string {
    const root = fs.mkdtempSync(join(os.tmpdir(), "codex-home-"));
    const dir = join(root, "sessions", "2026", "06", "11");
    fs.mkdirSync(dir, { recursive: true });
    // Two sessions for the project, one for another cwd, and a torn file.
    fs.writeFileSync(
      join(dir, "rollout-a.jsonl"),
      meta("019d3003-2649-7c40-a990-dc49ebb6ec3e", "/home/user/proj"),
    );
    fs.writeFileSync(
      join(dir, "rollout-b.jsonl"),
      meta("019d4444-2649-7c40-a990-dc49ebb6ec3e", "/home/user/proj"),
    );
    fs.writeFileSync(join(dir, "rollout-c.jsonl"), meta("other", "/somewhere/else"));
    fs.writeFileSync(join(dir, "torn.jsonl"), "{not json");
    // Make rollout-b the newest so it sorts first.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(join(dir, "rollout-b.jsonl"), future, future);
    return root;
  }

  it("lists cwd-matched sessions newest-first by mtime, keeping UUIDv7 ids", async () => {
    const root = setup();
    const sessions = await listCodexSessions(root, "/home/user/proj");
    expect(sessions.map((s) => s.sessionId)).toEqual([
      "019d4444-2649-7c40-a990-dc49ebb6ec3e",
      "019d3003-2649-7c40-a990-dc49ebb6ec3e",
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("honours the limit", async () => {
    const root = setup();
    const sessions = await listCodexSessions(root, "/home/user/proj", 1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("019d4444-2649-7c40-a990-dc49ebb6ec3e");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns [] when sessions dir is absent or nothing matches", async () => {
    const root = setup();
    expect(await listCodexSessions(root, "/nope")).toEqual([]);
    const empty = fs.mkdtempSync(join(os.tmpdir(), "codex-home-"));
    expect(await listCodexSessions(empty, "/home/user/proj")).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
