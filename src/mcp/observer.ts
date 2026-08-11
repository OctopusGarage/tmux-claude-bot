import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ControlClient } from "../adapters/control/client.js";
import type { DashboardSnapshot } from "../core/dashboard/dashboard.js";
import { listLoopReports } from "../core/loop/report.js";
import { OBSERVER_MCP_TOOLS } from "../core/mcp/profiles.js";
import { discoverRuntimeGuardianFindings } from "../core/runtime-guardian/service.js";
import { DailyTaskAuditStore } from "../core/tasks/daily-audit-service.js";
import {
  DailyTaskLedger,
  previousSingaporeDayWindow,
  summarizeTaskWindow,
  type TaskWindow,
} from "../core/tasks/task-ledger.js";
import { appVersion } from "../shared/version.js";

export type ObserverClient = Pick<
  ControlClient,
  "close" | "connect" | "logs" | "projects" | "snapshot"
>;
type ObserverDailyTaskLedger = Pick<DailyTaskLedger, "listForWindow">;
type ObserverDailyTaskAuditStore = Pick<DailyTaskAuditStore, "getLastFired">;

export type ObserverDeps = {
  now?: () => number;
  dailyTaskLedger?: () => ObserverDailyTaskLedger;
  dailyTaskAuditStore?: () => ObserverDailyTaskAuditStore;
  discoverRuntimeGuardianFindings?: typeof discoverRuntimeGuardianFindings;
  listLoopReports?: typeof listLoopReports;
};

export { OBSERVER_MCP_TOOLS };

type ObserverToolResponse = {
  ok: boolean;
  role: "observer";
  capability: "read-only observation";
  data: unknown;
  evidence: string[];
  blockedReason: string | null;
};

function response(data: unknown, evidence: string[]): ObserverToolResponse {
  return {
    ok: true,
    role: "observer",
    capability: "read-only observation",
    data,
    evidence,
    blockedReason: null,
  };
}

function blocked(error: unknown): ObserverToolResponse {
  return {
    ok: false,
    role: "observer",
    capability: "read-only observation",
    data: null,
    evidence: [],
    blockedReason: error instanceof Error ? error.message : String(error),
  };
}

function toolResult(payload: ObserverToolResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function withClient<T>(
  makeClient: () => ObserverClient,
  fn: (client: ObserverClient) => Promise<T>,
): Promise<T> {
  const client = makeClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function statusData(snapshot: DashboardSnapshot): unknown {
  return {
    generatedAt: snapshot.generatedAt,
    global: snapshot.global,
  };
}

function recentTaskWindow(now: number): TaskWindow {
  return {
    start: now - 7 * 24 * 60 * 60 * 1000,
    end: now,
    label: "last 7 days",
  };
}

export function createObserverMcpServer(
  makeClient: () => ObserverClient = () => new ControlClient(),
  deps: ObserverDeps = {},
  serverName = "tcb-observer",
): McpServer {
  const server = new McpServer({ name: serverName, version: appVersion() });
  const now = deps.now ?? Date.now;
  const dailyTaskLedger = deps.dailyTaskLedger ?? (() => new DailyTaskLedger());
  const dailyTaskAuditStore = deps.dailyTaskAuditStore ?? (() => new DailyTaskAuditStore());
  const readLoopReports = deps.listLoopReports ?? listLoopReports;
  const readRuntimeGuardianFindings =
    deps.discoverRuntimeGuardianFindings ?? discoverRuntimeGuardianFindings;

  server.registerTool(
    "tcb.observer.status",
    {
      title: "tmux-claude-bot Status",
      description: "Read global tmux-claude-bot status from the local control socket.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response(statusData(await client.snapshot()), ["control:snapshot"]),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err));
      }
    },
  );

  server.registerTool(
    "tcb.observer.projects",
    {
      title: "tmux-claude-bot Projects",
      description: "Read known projects from the local control socket.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response(await client.projects(), ["control:projects"]),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err));
      }
    },
  );

  server.registerTool(
    "tcb.observer.sessions",
    {
      title: "tmux-claude-bot Sessions",
      description: "Read live session rows from the local control socket.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response((await client.snapshot()).sessions, ["control:snapshot.sessions"]),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err));
      }
    },
  );

  server.registerTool(
    "tcb.observer.queue",
    {
      title: "tmux-claude-bot Queue",
      description: "Read queue and busy counts from the local control socket.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) => {
            const snapshot = await client.snapshot();
            return response(
              {
                queueDepth: snapshot.global.queueDepth,
                busyCount: snapshot.global.busyCount,
                runningCount: snapshot.global.runningCount,
                sessionCount: snapshot.global.sessionCount,
              },
              ["control:snapshot.global"],
            );
          }),
        );
      } catch (err) {
        return toolResult(blocked(err));
      }
    },
  );

  server.registerTool(
    "tcb.observer.logs_query",
    {
      title: "tmux-claude-bot Session Logs",
      description: "Read formatted WARN/ERROR logs scoped to one session.",
      inputSchema: z.object({ session: z.string().min(1) }),
    },
    async ({ session }) => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response({ session, text: await client.logs(session) }, ["control:logs"]),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err));
      }
    },
  );

  server.registerTool(
    "tcb.observer.loop_reports_list",
    {
      title: "tmux-claude-bot Loop Reports",
      description: "Read persisted Loop Engineering report records from state.",
      inputSchema: z.object({}),
    },
    async () => toolResult(response(readLoopReports(), ["state:loop-runs"])),
  );

  server.registerTool(
    "tcb.observer.daily_task_audit",
    {
      title: "tmux-claude-bot Daily Task Audit",
      description: "Read Daily Task Audit ledger summaries without triggering audit or repair.",
      inputSchema: z.object({}),
    },
    async () => {
      const observedAt = now();
      const ledger = dailyTaskLedger();
      const auditStore = dailyTaskAuditStore();
      const summaryWindow = previousSingaporeDayWindow(observedAt);
      const recentWindow = recentTaskWindow(observedAt);
      const summary = summarizeTaskWindow({
        records: ledger.listForWindow(summaryWindow),
        now: observedAt,
        window: summaryWindow,
      });
      const recentRecords = ledger
        .listForWindow(recentWindow)
        .sort((a, b) => b.scheduledAt - a.scheduledAt || a.taskId.localeCompare(b.taskId))
        .slice(0, 50);
      return toolResult(
        response(
          {
            observedAt,
            lastFiredAt: auditStore.getLastFired() ?? null,
            summary,
            recentWindow,
            recentRecords,
            recentLimit: 50,
          },
          ["state:daily_task_audit_lastfired", "state:scheduled_task_ledger"],
        ),
      );
    },
  );

  server.registerTool(
    "tcb.observer.runtime_guardian_findings",
    {
      title: "tmux-claude-bot Runtime Guardian Findings",
      description: "Read current Runtime Guardian findings without dispatching repair.",
      inputSchema: z.object({
        lookbackHours: z.number().int().min(1).max(168).optional(),
      }),
    },
    async ({ lookbackHours }) => {
      const observedAt = now();
      const hours = lookbackHours ?? 24;
      return toolResult(
        response(
          {
            observedAt,
            lookbackHours: hours,
            findings: readRuntimeGuardianFindings({
              now: observedAt,
              lookbackMs: hours * 60 * 60 * 1000,
            }),
          },
          ["state:loop-supervisor-work-orders", "state:runtime-guardian-discovery"],
        ),
      );
    },
  );

  return server;
}

export async function runObserverMcpServer(): Promise<void> {
  const server = createObserverMcpServer();
  await server.connect(new StdioServerTransport());
}
