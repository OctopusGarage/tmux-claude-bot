import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProfile } from "../src/core/agents/codex/codex-profile.js";
import type { ReadResolver } from "../src/core/agents/types.js";

/**
 * Scenario tests for the codex AgentProfile's read side — the wiring that turns a
 * resolved CODEX_HOME + live rollout into /history rounds, the latest reply, and
 * the resumable session list. The key invariant: with NO codex home resolved
 * (none running) every read degrades to empty/null instead of throwing, and with
 * a home + live rollout it reads exactly that rollout.
 */

const UUID = "abcdef01-2345-6789-abcd-ef0123456789";

/** A ReadResolver reporting a chosen CODEX_HOME and (optionally) the live pid's
 * open rollout path. */
function resolver(opts: { home?: string | null; rolloutPath?: string | null }): ReadResolver {
  return {
    resolveConfigRoot: async () => "/cfg",
    resolveCodexHome: async () => opts.home ?? null,
    resolveLiveTranscript: async () => (opts.rolloutPath ? { path: opts.rolloutPath } : null),
  };
}

function writeRollout(lines: object[]): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "tcb-cxprof-"));
  const p = join(dir, `rollout-2026-06-17T00-00-00-${UUID}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}
const userMsg = (text: string) => ({
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const asstMsg = (text: string) => ({
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
});

describe("codexProfile read side — no codex home (nothing running)", () => {
  const r = resolver({ home: null });
  it("getRecentConversations returns [] (no throw)", async () => {
    expect(await codexProfile.getRecentConversations(r, "sess", "/proj")).toEqual([]);
  });
  it("getLatestReply returns null", async () => {
    expect(await codexProfile.getLatestReply(r, "sess", "/proj", "hi")).toBeNull();
  });
  it("listSessions returns []", async () => {
    expect(await codexProfile.listSessions(r, "sess", "/proj")).toEqual([]);
  });
});

describe("codexProfile read side — home + live rollout", () => {
  it("getRecentConversations reads the live rollout into rounds (newest-first)", async () => {
    const path = writeRollout([
      userMsg("first question"),
      asstMsg("first answer"),
      userMsg("second question"),
      asstMsg("second answer"),
    ]);
    const rounds = await codexProfile.getRecentConversations(
      resolver({ home: "/home/.codex", rolloutPath: path }),
      "sess",
      "/proj",
    );
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.user).toBe("second question"); // newest-first
    expect(rounds[0]?.assistant).toBe("second answer");
  });

  it("getLatestReply returns the reply to the matching prompt from the live rollout", async () => {
    const path = writeRollout([userMsg("deploy please"), asstMsg("Deployed.")]);
    const reply = await codexProfile.getLatestReply(
      resolver({ home: "/home/.codex", rolloutPath: path }),
      "sess",
      "/proj",
      "deploy please",
    );
    expect(reply).toBe("Deployed.");
  });
});

describe("codexProfile.listSessions — walks CODEX_HOME/sessions for cwd-matched rollouts", () => {
  it("returns the session id of a rollout whose session_meta.cwd matches the project", async () => {
    const home = fs.mkdtempSync(join(tmpdir(), "tcb-cxhome-"));
    const sessDir = join(home, "sessions", "2026", "06", "17");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      join(sessDir, `rollout-2026-06-17T00-00-00-${UUID}.jsonl`),
      JSON.stringify({ payload: { type: "session_meta", cwd: "/proj", id: UUID } }),
    );
    const sessions = await codexProfile.listSessions(resolver({ home }), "sess", "/proj");
    expect(sessions.map((s) => s.sessionId)).toContain(UUID);
  });

  it("excludes rollouts whose cwd does NOT match the project", async () => {
    const home = fs.mkdtempSync(join(tmpdir(), "tcb-cxhome2-"));
    const sessDir = join(home, "sessions", "2026", "06", "17");
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      join(sessDir, `rollout-2026-06-17T00-00-00-${UUID}.jsonl`),
      JSON.stringify({ payload: { type: "session_meta", cwd: "/other-project", id: UUID } }),
    );
    expect(await codexProfile.listSessions(resolver({ home }), "sess", "/proj")).toEqual([]);
  });
});

describe("codexProfile.discoverSessionId / buildResumeCommand", () => {
  it("prefers the openSession id when the pid exposes one", async () => {
    const id = await codexProfile.discoverSessionId({
      openSession: UUID,
      cwd: "/proj",
      configRoot: "/home/.codex",
    });
    expect(id).toBe(UUID);
  });

  it("builds a resume command carrying --yolo only when the original had it", () => {
    expect(
      codexProfile.buildResumeCommand({
        aliasName: null,
        bin: "codex",
        configRoot: "/home/.codex",
        sessionId: UUID,
        origCmd: "codex --yolo",
      }),
    ).toContain(`resume ${UUID}`);
    expect(
      codexProfile.buildResumeCommand({
        aliasName: null,
        bin: "codex",
        configRoot: "/home/.codex",
        sessionId: UUID,
        origCmd: "codex",
      }),
    ).not.toContain("--yolo");
  });
});
