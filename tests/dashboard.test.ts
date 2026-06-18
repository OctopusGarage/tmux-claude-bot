import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPathToHistoryDir } from "../src/core/agents/claude/claude-history.js";
import type { SessionRow } from "../src/core/dashboard/dashboard.js";
import { buildDashboard } from "../src/core/dashboard/dashboard.js";
import { setPathForSession } from "../src/core/projects/sessionPathMap.js";

function fakeDeps(over: Record<string, unknown> = {}) {
  return {
    bridge: {
      listProjectSessions: async () => ["sess_a", "sess_b"],
      sessionsCreatedAt: async () => new Map([["sess_a", Math.floor(Date.now() / 1000) - 60]]),
      capturePane: async () => "", // idle pane: no mid-turn marker
    },
    configResolver: {
      detectAgentKind: async () => "claude",
      resolveApiInfo: async () => ({ baseUrl: null, mode: "subscription" }),
    },
    queue: { size: () => 3 },
    config: { telegramBotToken: "x", lark: undefined },
    ...over,
  } as never;
}

function row(rows: SessionRow[], session: string): SessionRow {
  const found = rows.find((r) => r.session === session);
  if (!found) throw new Error(`no row for ${session}`);
  return found;
}

describe("buildDashboard", () => {
  it("aggregates one row per session with global totals", async () => {
    const snap = await buildDashboard(fakeDeps(), { paneDiffMs: 0 });
    expect(snap.sessions).toHaveLength(2);
    expect(snap.global.sessionCount).toBe(2);
    expect(snap.global.queueDepth).toBe(3);
    expect(snap.global.adapters).toEqual({ telegram: true, lark: false });
    expect(typeof snap.global.version).toBe("string");
    expect(snap.generatedAt).toBeGreaterThan(0);
    const a = row(snap.sessions, "sess_a");
    expect(a.kind).toBe("claude");
    expect(a.uptimeMs).toBeGreaterThan(0); // had a created time
    expect(a.apiMode).toBe("subscription");
    expect(typeof a.busy).toBe("boolean");
    expect(typeof a.cumulativeBusyMs).toBe("number");
    expect(row(snap.sessions, "sess_b").uptimeMs).toBe(0); // no created time
  });

  it("marks a session busy from recent transcript activity (no bot task)", async () => {
    // A claude transcript written just now (mtime ≈ now) means the agent is
    // working — even though nothing was dispatched through the bot queue.
    const root = mkdtempSync(join(tmpdir(), "tcb-cfg-"));
    const proj = mkdtempSync(join(tmpdir(), "tcb-proj-"));
    const dir = projectPathToHistoryDir(proj, root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "11111111-1111-1111-1111-111111111111.jsonl"), "{}\n");
    setPathForSession("busy_sess", proj);
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: async () => ["busy_sess"],
        sessionsCreatedAt: async () => new Map(),
      },
      configResolver: {
        detectAgentKind: async () => "claude",
        resolveApiInfo: async () => null,
        resolveConfigRoot: async () => root,
        resolveLiveTranscript: async () => null,
      },
    });
    const r = row((await buildDashboard(deps, { paneDiffMs: 0 })).sessions, "busy_sess");
    expect(r.busy).toBe(true);
    expect(r.taskMs).toBeUndefined(); // desktop-driven → busy, but no bot-task duration
  });

  it("marks a session busy when the pane is animating (silent tool call / bg task, no transcript)", async () => {
    // No bot task, no recent transcript. The pane changes across the diff window
    // (a spinner / elapsed timer is ticking), so the agent is working.
    let n = 0;
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: async () => ["pane_busy"],
        sessionsCreatedAt: async () => new Map(),
        capturePane: async () => `✻ Working… (${n++}s)`, // differs between the two captures
      },
      configResolver: {
        detectAgentKind: async () => "claude",
        resolveApiInfo: async () => null,
        resolveConfigRoot: async () => "/no-such-config", // no transcript → not live-active
        resolveLiveTranscript: async () => null,
      },
    });
    expect(row((await buildDashboard(deps, { paneDiffMs: 0 })).sessions, "pane_busy").busy).toBe(
      true,
    );
  });

  it("leaves a session idle when the pane is static across the diff window", async () => {
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: async () => ["still"],
        sessionsCreatedAt: async () => new Map(),
        capturePane: async () => "❯ idle composer", // identical on both captures
      },
      configResolver: {
        detectAgentKind: async () => "claude",
        resolveApiInfo: async () => null,
        resolveConfigRoot: async () => "/no-such-config",
        resolveLiveTranscript: async () => null,
      },
    });
    expect(row((await buildDashboard(deps, { paneDiffMs: 0 })).sessions, "still").busy).toBe(false);
  });

  it("isolates a failing session (one bad resolve doesn't sink the snapshot)", async () => {
    const deps = fakeDeps({
      configResolver: {
        detectAgentKind: async (s: string) => {
          if (s === "sess_a") throw new Error("boom");
          return "codex";
        },
        resolveApiInfo: async () => null,
      },
    });
    const snap = await buildDashboard(deps, { paneDiffMs: 0 });
    expect(snap.sessions).toHaveLength(2); // both rows present despite sess_a throwing
    expect(row(snap.sessions, "sess_a").kind).toBe("claude"); // degraded default
    expect(row(snap.sessions, "sess_b").kind).toBe("codex");
  });
});
