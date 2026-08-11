import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlClient } from "../../src/adapters/control/client.js";
import type { DashboardSnapshot } from "../../src/core/dashboard/dashboard.js";
import { createHomeMcpServer, HOME_MCP_TOOLS } from "../../src/mcp/home.js";
import { OBSERVER_MCP_TOOLS, type ObserverClient } from "../../src/mcp/observer.js";

function fakeClient(
  overrides: Partial<ObserverClient & Pick<ControlClient, "autopilot" | "send">> = {},
) {
  return {
    autopilot: vi.fn(async () => ({ status: "delegated" })),
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
    send: vi.fn(async () => ({ status: "queued" })),
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

async function connectHomeClient(makeClient = () => fakeClient()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createHomeMcpServer(makeClient);
  const client = new Client({ name: "home-test", version: "1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("home MCP server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers observer tools plus controlled Home tools", async () => {
    const { client, server } = await connectHomeClient();
    try {
      expect(client.getServerVersion()?.name).toBe("tcb-home-operator");
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
        [...OBSERVER_MCP_TOOLS, ...HOME_MCP_TOOLS].sort(),
      );
      expect(listed.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends prompts through the control client", async () => {
    const send = vi.fn(async () => ({ status: "queued" }));
    const { client, server } = await connectHomeClient(() => fakeClient({ send }));
    try {
      const result = await client.callTool({
        name: "tcb.home.send_prompt",
        arguments: { session: "tmux_proj_demo", text: "continue" },
      });
      expect(send).toHaveBeenCalledWith("tmux_proj_demo", "continue");
      expect(result.structuredContent).toMatchObject({
        ok: true,
        role: "home",
        capability: "controlled operation",
        data: { session: "tmux_proj_demo", result: { status: "queued" } },
        evidence: ["control:send", "control:queue-gate"],
        blockedReason: null,
        scope: { kind: "controlled-operation", session: "tmux_proj_demo" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("delegates Autopilot through the control client", async () => {
    const autopilot = vi.fn(async () => ({ status: "delegated" }));
    const { client, server } = await connectHomeClient(() => fakeClient({ autopilot }));
    try {
      const result = await client.callTool({
        name: "tcb.home.delegate_autopilot",
        arguments: { session: "tmux_proj_demo", requirement: "fix the failing test" },
      });
      expect(autopilot).toHaveBeenCalledWith("tmux_proj_demo", "delegate fix the failing test");
      expect(result.structuredContent).toMatchObject({
        ok: true,
        role: "home",
        capability: "controlled operation",
        data: {
          session: "tmux_proj_demo",
          requirement: "fix the failing test",
          result: { status: "delegated" },
        },
        evidence: ["control:autopilot", "control:work-order-gate"],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    ["", "delegate"],
    ["delegate finish the slice", "delegate finish the slice"],
  ])("normalizes delegation requirement %j to %j", async (requirement, expectedVerb) => {
    const autopilot = vi.fn(async () => ({ status: "delegated" }));
    const { client, server } = await connectHomeClient(() => fakeClient({ autopilot }));
    try {
      const result = await client.callTool({
        name: "tcb.home.delegate_autopilot",
        arguments: { session: "tmux_proj_demo", requirement },
      });
      expect(autopilot).toHaveBeenCalledWith("tmux_proj_demo", expectedVerb);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        data: { session: "tmux_proj_demo", requirement },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports control failures as blocked Home tool results", async () => {
    const { client, server } = await connectHomeClient(() =>
      fakeClient({
        connect: vi.fn(async () => {
          throw new Error("not connected");
        }),
      }),
    );
    try {
      const result = await client.callTool({
        name: "tcb.home.send_prompt",
        arguments: { session: "tmux_proj_demo", text: "continue" },
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        role: "home",
        blockedReason: "control-unavailable",
        errorKind: "control-unavailable",
        scope: { kind: "controlled-operation", session: "tmux_proj_demo" },
        evidence: ["control:send", "control:queue-gate"],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports Autopilot control failures as blocked Home tool results and closes the client", async () => {
    const close = vi.fn();
    const { client, server } = await connectHomeClient(() =>
      fakeClient({
        close,
        autopilot: vi.fn(async () => {
          throw new Error("delegation blocked");
        }),
      }),
    );
    try {
      const result = await client.callTool({
        name: "tcb.home.delegate_autopilot",
        arguments: { session: "tmux_proj_demo", requirement: "fix coverage" },
      });
      expect(result.structuredContent).toMatchObject({
        ok: false,
        role: "home",
        blockedReason: "operation-blocked",
        errorKind: "operation-blocked",
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
