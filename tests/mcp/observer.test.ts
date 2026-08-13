import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "../../src/core/dashboard/dashboard.js";
import type { ScheduledTaskRecord } from "../../src/core/tasks/task-ledger.js";
import {
  createObserverMcpServer,
  OBSERVER_MCP_TOOLS,
  type ObserverClient,
} from "../../src/mcp/observer.js";

function fakeClient(overrides: Partial<ObserverClient> = {}) {
  return {
    close: vi.fn(),
    connect: vi.fn(async () => undefined),
    dailyTaskAuditStatus: vi.fn(async () => ({
      observedAt: 1,
      lastFiredAt: null,
      summary: {
        window: null,
        counts: { success: 0, failed: 0, missing: 0, running: 0, runningTimeout: 0, skipped: 0 },
        items: [],
      },
      recentWindow: { start: 0, end: 1, label: "recent" },
      recentRecords: [],
      recentLimit: 50,
      recentTotal: 0,
      recentTruncated: false,
    })),
    logs: vi.fn(async (session: string) => `logs for ${session}`),
    loopReports: vi.fn(async () => ({ items: [], total: 0, limit: 20, truncated: false })),
    projects: vi.fn(async () => [{ sid: "demo", label: "Demo", alive: true, active: false }]),
    runtimeGuardianFindings: vi.fn(async () => ({
      observedAt: 1,
      lookbackHours: 24,
      findings: [],
      total: 0,
      limit: 50,
      truncated: false,
    })),
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
        overview: {
          health: { status: "attention", attentionCount: 1, degradedDomainCount: 0 },
          attention: {
            items: [
              {
                id: "power:policy",
                domain: "power",
                severity: "warning",
                observedAt: 1,
                summary: "Wake schedule needs attention",
                nextAction: "tcb power status",
              },
            ],
            total: 1,
            limit: 10,
            truncated: false,
          },
          activeWork: { items: [], total: 0, limit: 10, truncated: false },
          automation: [],
          runtimeDomains: [],
          operator: {
            session: { state: "ready" },
            skills: { installed: 2, expected: 2, state: "ready" },
            mcpProfiles: { installed: 2, expected: 2, state: "ready", profiles: [] },
            promptLibrary: { state: "disabled" },
            optionalProjectMcpCount: 0,
          },
          recentOutcomes: { items: [], total: 0, limit: 10, truncated: false },
          degradedDomains: [],
        },
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
      expect(listed.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
      const advertised = Object.fromEntries(
        listed.tools.map((tool) => [tool.name, JSON.stringify(tool.outputSchema)]),
      );
      expect(advertised["tcb.observer.status"]).toContain('"runtimeDomains"');
      expect(advertised["tcb.observer.loop_reports_list"]).toContain('"projectName"');
      expect(advertised["tcb.observer.daily_task_audit"]).toContain('"runningTimeout"');
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
        data: {
          global: { queueDepth: 0, sessionCount: 1 },
          overview: { health: { status: "attention", attentionCount: 1 } },
          sessions: [],
        },
        evidence: ["control:snapshot"],
        blockedReason: null,
        scope: { kind: "runtime-overview" },
        errorKind: null,
        nextSuggestedAction: "tcb power status",
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
        blockedReason: "control-unavailable",
        errorKind: "control-unavailable",
        nextSuggestedAction: "tcb service status",
        scope: { kind: "runtime-overview" },
        evidence: ["control:snapshot"],
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
    const dailyTaskAuditStatus = vi.fn(async () => ({
      observedAt: 1_785_657_600_000,
      lastFiredAt: 1_785_571_200_000,
      summary: {
        window: null,
        counts: { success: 1, failed: 0, missing: 0, running: 0, runningTimeout: 0, skipped: 0 },
        items: [{ ...record, status: "success" as const }],
      },
      recentWindow: { start: 1, end: 2, label: "recent" },
      recentRecords: [record],
      recentLimit: 50,
      recentTotal: 1,
      recentTruncated: false,
    }));
    const { client, server } = await connectObserverClient({}, () =>
      fakeClient({ dailyTaskAuditStatus }),
    );
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
          recentTotal: 1,
          recentTruncated: false,
        },
        evidence: ["control:daily-task-audit"],
      });
      expect(dailyTaskAuditStatus).toHaveBeenCalledWith();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns Runtime Guardian findings without dispatching repair", async () => {
    const runtimeGuardianFindings = vi.fn(async () => ({
      observedAt: 1_785_657_600_000,
      lookbackHours: 6,
      findings: [
        {
          kind: "missing-system-gate" as const,
          severity: "high" as const,
          runId: "run-1",
          projectId: "tmux-claude-bot",
          projectPath: "/repo",
          evidence: ["system gate evidence is missing"],
        },
      ],
      total: 1,
      limit: 50,
      truncated: false,
    }));
    const { client, server } = await connectObserverClient({}, () =>
      fakeClient({ runtimeGuardianFindings }),
    );
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
          total: 1,
          limit: 50,
          truncated: false,
        },
        evidence: ["control:runtime-guardian-findings"],
      });
      expect(runtimeGuardianFindings).toHaveBeenCalledWith({
        lookbackHours: 6,
        limit: 50,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses injected Loop report discovery and the default Runtime Guardian lookback", async () => {
    const loopReports = vi.fn(async () => ({
      items: [
        {
          runId: "run-1",
          projectId: "repo",
          projectName: "Repo",
          status: "passed" as const,
          startedAt: 1,
          endedAt: 2,
          markdownPath: "~/report.md",
          summaryPath: "~/summary.json",
        },
      ],
      total: 1,
      limit: 5,
      truncated: false,
    }));
    const runtimeGuardianFindings = vi.fn(async () => ({
      observedAt: 1_785_657_600_000,
      lookbackHours: 24,
      findings: [],
      total: 0,
      limit: 50,
      truncated: false,
    }));
    const { client, server } = await connectObserverClient({}, () =>
      fakeClient({ loopReports, runtimeGuardianFindings }),
    );
    try {
      await expect(
        client.callTool({
          name: "tcb.observer.loop_reports_list",
          arguments: { limit: 5, projectId: "repo", status: "passed" },
        }),
      ).resolves.toMatchObject({
        structuredContent: {
          ok: true,
          data: {
            items: [{ runId: "run-1", projectId: "repo", status: "passed" }],
            total: 1,
            limit: 5,
            truncated: false,
          },
          evidence: ["control:loop-reports"],
        },
      });
      expect(loopReports).toHaveBeenCalledWith({
        limit: 5,
        projectId: "repo",
        status: "passed",
      });
      await client.callTool({
        name: "tcb.observer.runtime_guardian_findings",
        arguments: {},
      });
      expect(runtimeGuardianFindings).toHaveBeenCalledWith({
        lookbackHours: 24,
        limit: 50,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
