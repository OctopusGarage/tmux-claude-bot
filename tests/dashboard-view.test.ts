import { describe, expect, it } from "vitest";
import type { DashboardSnapshot } from "../src/core/dashboard/dashboard.js";
import {
  dashboardLabelsForMessages,
  formatDashboardForChat,
  formatDashboardText,
} from "../src/core/dashboard/dashboard-view.js";
import { zh } from "../src/core/i18n/catalog/zh.js";

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
  overview: {
    health: { status: "attention", attentionCount: 2, degradedDomainCount: 0 },
    attention: {
      items: [
        {
          id: "loop:failed",
          domain: "loop",
          severity: "error",
          observedAt: 10,
          summary: "Loop failed",
          nextAction: "tcb loop reports list --limit 20",
        },
        {
          id: "power:policy",
          domain: "power",
          severity: "warning",
          observedAt: 9,
          summary: "Wake schedule missing",
          nextAction: "tcb power status",
        },
      ],
      total: 2,
      limit: 10,
      truncated: false,
    },
    activeWork: {
      items: [
        {
          id: "work-order:one",
          kind: "work-order",
          label: "proj-a architecture",
          status: "running",
          startedAt: 8,
          projectId: "proj-a",
        },
      ],
      total: 1,
      limit: 10,
      truncated: false,
    },
    automation: [
      {
        id: "loop",
        label: "Loop Engineering",
        enabled: true,
        configured: true,
        activeCount: 1,
        tickMs: 300_000,
      },
    ],
    runtimeDomains: [
      {
        id: "power",
        label: "Service and Power",
        status: "attention",
        summary: "scheduled",
        errorKind: null,
      },
    ],
    operator: {
      session: { state: "ready" },
      skills: { installed: 2, expected: 2, state: "ready" },
      mcpProfiles: {
        installed: 2,
        expected: 2,
        state: "ready",
        profiles: [
          {
            profile: "observer",
            role: "observer",
            exposure: "read-only",
            toolCount: 8,
            descriptorState: "ready",
          },
        ],
      },
      promptLibrary: { state: "disabled" },
      optionalProjectMcpCount: 1,
    },
    recentOutcomes: {
      items: [],
      total: 0,
      limit: 10,
      truncated: false,
    },
    degradedDomains: [],
  },
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

  it("renders health and attention before active work and sessions", () => {
    const out = formatDashboardText(snap);

    expect(out.startsWith("Overall Health: attention")).toBe(true);
    expect(out.indexOf("Attention (2)")).toBeLessThan(out.indexOf("Active Work (1)"));
    expect(out.indexOf("Active Work (1)")).toBeLessThan(out.indexOf("Project Sessions"));
    expect(out).toContain("Operator and AI Interfaces");
    expect(out).toContain("observer · observer/read-only · 8 tools · ready");
  });

  it("can hide Lark-only project-group details for Telegram", () => {
    const out = formatDashboardForChat(snap, { maxChars: 3500, showGroups: false });
    expect(out).toContain("proj-a");
    expect(out).not.toContain("Proj A Group");
    expect(out).not.toContain("🗂 Proj A Group");
  });

  it("summarizes healthy automation and idle sessions in chat", () => {
    const out = formatDashboardForChat(snap, { maxChars: 3500, showGroups: false });

    expect(out).toContain("Automation: 1/1 enabled");
    expect(out).toContain("Project Sessions: 2 shown · 1 idle");
    expect(out).not.toContain("🟡 proj-b");
    expect(out).toContain("🟢 proj-a");
    expect(out).toContain("⚫ proj-c");
  });

  it("renders structured attention evidence through the chat locale", () => {
    const overview = snap.overview;
    if (overview === undefined) throw new Error("fixture overview is required");
    const first = overview.attention.items[0];
    if (first === undefined) throw new Error("fixture attention is required");
    const localized: DashboardSnapshot = {
      ...snap,
      overview: {
        ...overview,
        attention: {
          ...overview.attention,
          items: [
            {
              ...first,
              presentation: {
                kind: "work-order-failed",
                project: "项目甲",
                taskKind: "架构检查",
              },
            },
          ],
          total: 1,
        },
      },
    };

    const out = formatDashboardForChat(localized, {
      maxChars: 3500,
      labels: dashboardLabelsForMessages(zh),
    });
    expect(out).toContain("总体健康: 需处理");
    expect(out).toContain("项目甲 的工作单失败");
    expect(out).toContain("3 会话");
    expect(out).toContain("服务与电源");
    expect(out).not.toContain("Service and Power");
    expect(out).not.toContain("Loop failed");
  });

  it("renders only health and attention blocks in problems mode", () => {
    const out = formatDashboardText(snap, { problemsOnly: true });

    expect(out).toContain("Attention (2)");
    expect(out).not.toContain("\n\nActive Work");
    expect(out).not.toContain("\nAutomation");
    expect(out).not.toContain("\nProject Sessions");
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
