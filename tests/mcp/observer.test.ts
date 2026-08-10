import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "../../src/core/dashboard/dashboard.js";
import type { ScheduledTaskRecord } from "../../src/core/tasks/task-ledger.js";
import { createObserverMcpServer, OBSERVER_MCP_TOOLS } from "../../src/mcp/observer.js";

function fakeClient(
  overrides: Partial<{
    close: () => void;
    connect: () => Promise<void>;
    logs: (session: string) => Promise<string>;
    projects: () => Promise<{ sid: string; label: string; alive: boolean; active: boolean }[]>;
    snapshot: () => Promise<DashboardSnapshot>;
  }> = {},
) {
  return {
    close: vi.fn(),
    connect: vi.fn(async () => undefined),
    logs: vi.fn(async (session: string) => `logs for ${session}`),
    projects: vi.fn(async () => [{ sid: "demo", label: "Demo", alive: true, active: false }]),
    snapshot: vi.fn(
      async (): Promise<DashboardSnapshot> => ({
        generatedAt: 1,
        global: {
          botUptimeMs: 10,
          version: "0.0.0-test",
          sessionCount: 1,
          runningCount: 1,
          busyCount: 0,
          queueDepth: 0,
          adapters: { telegram: true, lark: false },
        },
        sessions: [],
      }),
    ),
    ...overrides,
  };
}

async function connectTestClient(makeClient = () => fakeClient()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createObserverMcpServer(makeClient);
  const client = new Client({ name: "observer-test", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function connectObserverClient(
  deps: Parameters<typeof createObserverMcpServer>[1],
  makeClient = () => fakeClient(),
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createObserverMcpServer(makeClient, deps);
  const client = new Client({ name: "observer-test", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("observer MCP server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers only observer tools", async () => {
    const { client, server } = await connectTestClient();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...OBSERVER_MCP_TOOLS].sort());
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structured read-only status data", async () => {
    const { client, server } = await connectTestClient();
    try {
      const result = await client.callTool({ name: "tcb.observer.status", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        role: "observer",
        capability: "read-only observation",
        data: { global: { queueDepth: 0, sessionCount: 1 } },
        evidence: ["control:snapshot"],
        blockedReason: null,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns projects, sessions, queue, and scoped logs through read-only control calls", async () => {
    const snapshot = vi.fn(
      async (): Promise<DashboardSnapshot> => ({
        generatedAt: 2,
        global: {
          botUptimeMs: 20,
          version: "0.0.0-test",
          sessionCount: 2,
          runningCount: 1,
          busyCount: 1,
          queueDepth: 3,
          adapters: { telegram: true, lark: true },
        },
        sessions: [
          {
            session: "tmux_proj_demo",
            label: "Demo",
            sessionKind: "regular",
            workspacePath: "/repo/demo",
            independentSlot: null,
            group: null,
            kind: "codex",
            running: true,
            busy: false,
            cumulativeBusyMs: 0,
            uptimeMs: 20,
            usage: null,
          },
        ],
      }),
    );
    const projects = vi.fn(async () => [{ sid: "demo", label: "Demo", alive: true, active: true }]);
    const logs = vi.fn(async (session: string) => `logs for ${session}`);
    const { client, server } = await connectTestClient(() =>
      fakeClient({
        logs,
        projects,
        snapshot,
      }),
    );
    try {
      await expect(
        client.callTool({ name: "tcb.observer.projects", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: [{ sid: "demo", label: "Demo", alive: true, active: true }],
          evidence: ["control:projects"],
        },
      });
      await expect(
        client.callTool({ name: "tcb.observer.sessions", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: [{ session: "tmux_proj_demo", label: "Demo" }],
          evidence: ["control:snapshot.sessions"],
        },
      });
      await expect(
        client.callTool({ name: "tcb.observer.queue", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: { queueDepth: 3, busyCount: 1, runningCount: 1, sessionCount: 2 },
          evidence: ["control:snapshot.global"],
        },
      });
      await expect(
        client.callTool({
          name: "tcb.observer.logs_query",
          arguments: { session: "tmux_proj_demo" },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: { session: "tmux_proj_demo", text: "logs for tmux_proj_demo" },
          evidence: ["control:logs"],
        },
      });
      expect(projects).toHaveBeenCalledOnce();
      expect(logs).toHaveBeenCalledWith("tmux_proj_demo");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports control-socket failures as blocked tool results", async () => {
    const { client, server } = await connectTestClient(() =>
      fakeClient({
        connect: vi.fn(async () => {
          throw new Error("not connected");
        }),
      }),
    );
    try {
      const result = await client.callTool({ name: "tcb.observer.status", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        role: "observer",
        blockedReason: "not connected",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns Daily Task Audit ledger summaries without running repair", async () => {
    const record: ScheduledTaskRecord = {
      taskId: "daily-audit:test",
      source: "daily-audit",
      name: "Daily scheduled task audit",
      scheduledAt: 1_785_571_200_000,
      status: "success",
      endedAt: 1_785_571_260_000,
      repairStatus: "not-needed",
      updatedAt: 1_785_571_260_000,
    };
    const listForWindow = vi.fn(() => [record]);
    const { client, server } = await connectObserverClient({
      now: () => 1_785_657_600_000,
      dailyTaskAuditStore: () => ({ getLastFired: () => 1_785_571_200_000 }),
      dailyTaskLedger: () => ({ listForWindow }),
    });
    try {
      const result = await client.callTool({
        name: "tcb.observer.daily_task_audit",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        role: "observer",
        data: {
          observedAt: 1_785_657_600_000,
          lastFiredAt: 1_785_571_200_000,
          summary: { counts: { success: 1 } },
          recentRecords: [{ taskId: "daily-audit:test", status: "success" }],
          recentLimit: 50,
        },
        evidence: ["state:daily_task_audit_lastfired", "state:scheduled_task_ledger"],
      });
      expect(listForWindow).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns Runtime Guardian findings without dispatching repair", async () => {
    const discoverRuntimeGuardianFindings = vi.fn(() => [
      {
        kind: "missing-system-gate" as const,
        severity: "high" as const,
        runId: "run-1",
        projectId: "tmux-claude-bot",
        projectPath: "/repo",
        evidence: ["system gate evidence is missing"],
      },
    ]);
    const { client, server } = await connectObserverClient({
      now: () => 1_785_657_600_000,
      discoverRuntimeGuardianFindings,
    });
    try {
      const result = await client.callTool({
        name: "tcb.observer.runtime_guardian_findings",
        arguments: { lookbackHours: 6 },
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        role: "observer",
        data: {
          observedAt: 1_785_657_600_000,
          lookbackHours: 6,
          findings: [{ kind: "missing-system-gate", severity: "high", runId: "run-1" }],
        },
        evidence: ["state:loop-supervisor-work-orders", "state:runtime-guardian-discovery"],
      });
      expect(discoverRuntimeGuardianFindings).toHaveBeenCalledWith({
        now: 1_785_657_600_000,
        lookbackMs: 6 * 60 * 60 * 1000,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses injected Loop report discovery and the default Runtime Guardian lookback", async () => {
    const listLoopReports = vi.fn(() => [
      {
        runId: "run-1",
        projectId: "repo",
        projectName: "Repo",
        status: "passed" as const,
        startedAt: 1,
        endedAt: 2,
        markdownPath: "/tmp/report.md",
        summaryPath: "/tmp/summary.json",
      },
    ]);
    const discoverRuntimeGuardianFindings = vi.fn(() => []);
    const { client, server } = await connectObserverClient({
      now: () => 1_785_657_600_000,
      listLoopReports,
      discoverRuntimeGuardianFindings,
    });
    try {
      await expect(
        client.callTool({ name: "tcb.observer.loop_reports_list", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: [{ runId: "run-1", projectId: "repo", status: "passed" }],
          evidence: ["state:loop-runs"],
        },
      });
      await client.callTool({
        name: "tcb.observer.runtime_guardian_findings",
        arguments: {},
      });
      expect(discoverRuntimeGuardianFindings).toHaveBeenCalledWith({
        now: 1_785_657_600_000,
        lookbackMs: 24 * 60 * 60 * 1000,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
