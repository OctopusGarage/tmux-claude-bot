import { describe, expect, it } from "vitest";
import type { DashboardSnapshot } from "../src/core/dashboard/dashboard.js";
import {
  formatDashboardForChat,
  formatDashboardText,
} from "../src/core/dashboard/dashboard-view.js";

const snap: DashboardSnapshot = {
  sessions: [
    {
      session: "tmux_proj_a",
      label: "proj-a",
      sessionKind: "regular",
      workspacePath: "/work/proj-a",
      independentSlot: null,
      group: { chatId: "oc_a", label: "Proj A Group" },
      kind: "claude",
      running: true,
      busy: true,
      taskMs: 72_000,
      cumulativeBusyMs: 3_600_000,
      uptimeMs: 10_800_000,
      usage: {
        sessionId: "x",
        contextPct: 47,
        fiveHourPct: 31,
        fiveHourReset: null,
        sevenDayPct: 5,
        sevenDayReset: null,
        updatedAt: 0,
      } as never,
      apiMode: "subscription",
    },
    {
      session: "tmux_proj_b",
      label: "proj-b",
      sessionKind: "independent",
      workspacePath: "/work/proj-b",
      independentSlot: 2,
      group: null,
      kind: "codex",
      running: true, // agent up but idle
      busy: false,
      cumulativeBusyMs: 0,
      uptimeMs: 90_000_000,
      usage: null,
    },
    {
      session: "tmux_proj_c",
      label: "proj-c",
      sessionKind: "regular",
      workspacePath: null,
      independentSlot: null,
      group: null,
      kind: "claude",
      running: false, // no agent in the pane → stopped
      busy: false,
      cumulativeBusyMs: 0,
      uptimeMs: 5_000,
      usage: null,
    },
  ],
  global: {
    botUptimeMs: 180_000_000,
    version: "0.1.9",
    sessionCount: 3,
    runningCount: 2,
    busyCount: 1,
    queueDepth: 1,
    adapters: { telegram: true, lark: false },
  },
  generatedAt: 0,
};

describe("dashboard-view", () => {
  it("renders the global header and per-session rows", () => {
    const out = formatDashboardText(snap);
    expect(out).toContain("0.1.9"); // version
    expect(out).toContain("proj-a");
    expect(out).toContain("proj-b");
    expect(out).toContain("🟠 Claude/sub"); // apiMode "subscription" rendered next to the kind
    expect(out).toContain("🔘 Codex");
    expect(out).toContain("🧩 independent #2");
    expect(out).toContain("🗂 Proj A Group");
    expect(out).toContain("📍 /work/proj-a");
    expect(out).toMatch(/busy/i);
    expect(out).toMatch(/idle/i);
    expect(out).toContain("47"); // context %
    expect(out).toMatch(/3 sessions/); // session count in header
  });

  it("can hide Lark-only project-group details for Telegram", () => {
    const out = formatDashboardForChat(snap, { maxChars: 3500, showGroups: false });
    expect(out).toContain("proj-a");
    expect(out).not.toContain("Proj A Group");
    expect(out).not.toContain("🗂 Proj A Group");
  });

  it("distinguishes the three states: busy 🟢, idle-running 🟡, stopped ⏹/⚫", () => {
    const out = formatDashboardText(snap);
    // proj-a busy, proj-b idle (running), proj-c stopped — each gets a distinct dot.
    expect(out).toContain("🟢 proj-a");
    expect(out).toContain("🟡 proj-b");
    expect(out).toContain("⚫ proj-c");
    expect(out).toMatch(/stopped/i); // proj-c's state line
    expect(out).toMatch(/2 running/); // header running count (a + b)
  });

  it("humanizes durations", () => {
    const out = formatDashboardText(snap);
    expect(out).toMatch(/1m12s|1m/); // taskMs 72s
    expect(out).toMatch(/3h/); // uptime 3h
  });

  it("chat variant caps length and keeps the header", () => {
    const out = formatDashboardForChat(snap, { maxChars: 120 });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("0.1.9"); // header preserved
  });

  it("handles an empty dashboard", () => {
    const empty: DashboardSnapshot = {
      sessions: [],
      global: { ...snap.global, sessionCount: 0, runningCount: 0, busyCount: 0 },
      generatedAt: 0,
    };
    expect(formatDashboardText(empty)).toMatch(/0 sessions/);
  });

  it("prefixes the operator row label with 🏠", () => {
    const opSnap: DashboardSnapshot = {
      sessions: [
        {
          session: "tmux_proj_home",
          label: "home",
          sessionKind: "operator",
          workspacePath: null,
          independentSlot: null,
          group: null,
          kind: "claude",
          running: true,
          busy: false,
          cumulativeBusyMs: 0,
          uptimeMs: 5_000,
          usage: null,
          operator: true,
        },
      ],
      global: {
        botUptimeMs: 0,
        version: "0.0.0",
        sessionCount: 0,
        runningCount: 0,
        busyCount: 0,
        queueDepth: 0,
        adapters: { telegram: false, lark: false },
      },
      generatedAt: 0,
    };
    const out = formatDashboardText(opSnap);
    expect(out).toContain("🏠 home");
  });
});
