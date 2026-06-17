import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRecentConversations,
  projectPathToHistoryDir,
} from "../src/core/agents/claude/claude-history.js";
import { parseCodexRounds } from "../src/core/agents/codex/codex-history.js";

/**
 * Cross-format guard for the shared JSONL line-reader (core/read/jsonl.ts,
 * `iterJsonlObjects`), which both claude and codex transcript parsers feed.
 *
 * The two transcript FORMATS differ at the object level — claude lines are
 * `{type:"user"|"assistant", message:{content}}`; codex lines are
 * `{payload:{type:"message", role, content:[{type:"input_text"|"output_text"}]}}`
 * — and each is interpreted by its own parser. The ONLY thing shared is the
 * line FRAMING (newline-delimited JSON, skip blank / torn / non-JSON lines).
 *
 * These tests pin two properties so a future change to the shared reader can't
 * silently break one agent:
 *   1. The SAME junk pattern (blank + malformed + torn-tail) is tolerated by
 *      BOTH real formats — the good round survives in each.
 *   2. The reader is format-agnostic: feeding one agent's lines to the other
 *      agent's parser yields nothing (the interpreters, not the reader, own the
 *      format knowledge).
 */

// A claude transcript line, matching the real on-disk shape.
const claudeLine = (type: "user" | "assistant", content: unknown): string =>
  JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });

// A codex rollout line, matching the real on-disk shape.
const codexLine = (role: "user" | "assistant", text: string): string =>
  JSON.stringify({
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });

// blank line, a non-JSON line, and a torn final fragment — the live-appended tail.
const BLANK = "";
const MALFORMED = "{ this is not json";
const TORN_TAIL = '{"payload":{"type":"mess';

describe("shared JSONL reader: junk tolerance across both transcript formats", () => {
  let configRoot: string;
  const projectPath = "/proj/shared-reader";
  let histDir: string;

  beforeEach(() => {
    configRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-shared-reader-"));
    histDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(histDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(configRoot, { recursive: true, force: true }));

  it("CLAUDE format: blank/malformed/torn lines are dropped, the real round survives", async () => {
    const lines = [
      BLANK,
      claudeLine("user", "valid claude question"),
      MALFORMED,
      claudeLine("assistant", "valid claude answer"),
      BLANK,
      TORN_TAIL,
    ];
    fs.writeFileSync(nodePath.join(histDir, "a.jsonl"), lines.join("\n"), "utf-8");

    const rounds = await getRecentConversations(projectPath, configRoot);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      user: "valid claude question",
      assistant: "valid claude answer",
    });
  });

  it("CODEX format: blank/malformed/torn lines are dropped, the real round survives", () => {
    const text = [
      BLANK,
      codexLine("user", "valid codex question"),
      MALFORMED,
      codexLine("assistant", "valid codex answer"),
      BLANK,
      TORN_TAIL,
    ].join("\n");

    const rounds = parseCodexRounds(text);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      user: "valid codex question",
      assistant: "valid codex answer",
    });
  });

  it("the reader is format-agnostic: each parser ignores the OTHER agent's lines", async () => {
    // codex lines fed to the claude parser → claude sees no `type:user|assistant` → empty.
    fs.writeFileSync(
      nodePath.join(histDir, "b.jsonl"),
      [codexLine("user", "q"), codexLine("assistant", "a")].join("\n"),
      "utf-8",
    );
    expect(await getRecentConversations(projectPath, configRoot)).toEqual([]);

    // claude lines fed to the codex parser → codex sees no `payload.type==="message"` → empty.
    expect(
      parseCodexRounds([claudeLine("user", "q"), claudeLine("assistant", "a")].join("\n")),
    ).toEqual([]);
  });
});
