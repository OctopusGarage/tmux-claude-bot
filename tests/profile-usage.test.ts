import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPathToHistoryDir } from "../src/core/agents/claude/claude-history.js";
import { claudeProfile } from "../src/core/agents/claude/claude-profile.js";
import { codexProfile } from "../src/core/agents/codex/codex-profile.js";

describe("AgentProfile.readUsage", () => {
  it("claude: returns null when no session id can be resolved", async () => {
    const resolver = {
      resolveConfigRoot: async () => "/nope",
      resolveLiveTranscript: async () => null,
    } as never;
    expect(await claudeProfile.readUsage(resolver, "s", "/proj")).toBeNull();
  });

  it("codex: returns null when no codex is running (no home)", async () => {
    const resolver = {
      resolveConfigRoot: async () => "/nope",
      resolveCodexHome: async () => null,
    } as never;
    expect(await codexProfile.readUsage(resolver, "s", "/proj")).toBeNull();
  });
});

describe("AgentProfile.lastActivityAt", () => {
  it("claude: returns the newest transcript's mtime (epoch ms)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-claude-"));
    const dir = projectPathToHistoryDir("/work/proj", root);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "11111111-1111-1111-1111-111111111111.jsonl");
    writeFileSync(f, "{}\n");
    utimesSync(f, 1_500_000, 1_500_000); // mtime = 1_500_000s
    const resolver = { resolveConfigRoot: async () => root } as never;
    expect(await claudeProfile.lastActivityAt?.(resolver, "s", "/work/proj")).toBe(
      1_500_000 * 1000,
    );
  });

  it("claude: returns null when the project has no transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "tcb-claude-"));
    const resolver = { resolveConfigRoot: async () => root } as never;
    expect(await claudeProfile.lastActivityAt?.(resolver, "s", "/work/none")).toBeNull();
  });

  it("codex: returns the matching rollout's mtime (epoch ms)", async () => {
    const home = mkdtempSync(join(tmpdir(), "tcb-codex-"));
    const dir = join(home, "sessions", "2026", "03", "27");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "rollout-2026-03-27T10-00-00-11111111-2222-3333-4444-555555555555.jsonl");
    writeFileSync(
      p,
      `${JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/work/proj" } })}\n`,
    );
    utimesSync(p, 2_000_000, 2_000_000);
    const resolver = { resolveCodexHome: async () => home } as never;
    expect(await codexProfile.lastActivityAt?.(resolver, "s", "/work/proj")).toBe(2_000_000 * 1000);
  });

  it("codex: returns null when no codex home", async () => {
    const resolver = { resolveCodexHome: async () => null } as never;
    expect(await codexProfile.lastActivityAt?.(resolver, "s", "/work/proj")).toBeNull();
  });
});
