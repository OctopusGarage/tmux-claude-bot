import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ControlClient } from "../adapters/control/client.js";
import type { DashboardSnapshot } from "../core/dashboard/dashboard.js";
import { OBSERVER_MCP_TOOLS } from "../core/mcp/profiles.js";
import { tildeifyHomeDeep } from "../shared/utils/path.js";
import { appVersion } from "../shared/version.js";

export type ObserverClient = Pick<
  ControlClient,
  | "close"
  | "connect"
  | "dailyTaskAuditStatus"
  | "logs"
  | "loopReports"
  | "projects"
  | "runtimeGuardianFindings"
  | "snapshot"
>;

export type ObserverDeps = Record<string, never>;

export { OBSERVER_MCP_TOOLS };

const observerScopeSchema = z.object({
  kind: z.enum([
    "observation",
    "runtime-overview",
    "projects",
    "sessions",
    "queue",
    "session-logs",
    "loop-reports",
    "daily-task-audit",
    "runtime-guardian",
  ]),
  session: z.string().optional(),
  projectId: z.string().optional(),
});

type ObserverScope = z.infer<typeof observerScopeSchema>;

type ObserverToolResponse<T> = {
  ok: boolean;
  role: "observer";
  capability: "read-only observation";
  data: T | null;
  evidence: string[];
  blockedReason: string | null;
  scope: ObserverScope;
  errorKind: "control-unavailable" | "read-failed" | null;
  nextSuggestedAction: string | null;
};

function observerOutputSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    ok: z.boolean(),
    role: z.literal("observer"),
    capability: z.literal("read-only observation"),
    data: data.nullable(),
    evidence: z.array(z.string()),
    blockedReason: z.string().nullable(),
    scope: observerScopeSchema,
    errorKind: z.enum(["control-unavailable", "read-failed"]).nullable(),
    nextSuggestedAction: z.string().nullable(),
  });
}

const usageSchema = z.object({
  sessionId: z.string(),
  contextPct: z.number().nullable(),
  fiveHourPct: z.number().nullable(),
  fiveHourReset: z.number().nullable(),
  sevenDayPct: z.number().nullable(),
  sevenDayReset: z.number().nullable(),
  updatedAt: z.number(),
});
const sessionSchema = z.object({
  session: z.string(),
  label: z.string(),
  sessionKind: z.enum(["regular", "independent", "operator"]),
  workspacePath: z.string().nullable(),
  independentSlot: z.number().nullable(),
  group: z.object({ chatId: z.string(), label: z.string() }).nullable(),
  kind: z.enum(["claude", "codex"]),
  running: z.boolean(),
  busy: z.boolean(),
  taskMs: z.number().optional(),
  task: z
    .object({ key: z.string(), startedAt: z.number(), source: z.enum(["queue", "transcript"]) })
    .optional(),
  cumulativeBusyMs: z.number(),
  uptimeMs: z.number(),
  usage: usageSchema.nullable(),
  apiMode: z.enum(["api", "subscription"]).optional(),
  operator: z.boolean().optional(),
});
const attentionPresentationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator-session") }),
  z.object({ kind: z.literal("operator-skills"), installed: z.number(), expected: z.number() }),
  z.object({ kind: z.literal("operator-mcp"), installed: z.number(), expected: z.number() }),
  z.object({ kind: z.literal("operator-prompt") }),
  z.object({
    kind: z.literal("work-order-failed"),
    project: z.string(),
    taskKind: z.string(),
  }),
  z.object({ kind: z.literal("work-order-abandoned"), project: z.string() }),
  z.object({ kind: z.literal("work-order-stale"), project: z.string() }),
  z.object({ kind: z.literal("automation-dependency"), automation: z.string() }),
  z.object({ kind: z.literal("daily-audit-attention"), count: z.number() }),
  z.object({
    kind: z.literal("runtime-finding"),
    project: z.string(),
    findingKind: z.string(),
  }),
  z.object({
    kind: z.literal("resource-pressure"),
    pressure: z.string(),
    circuit: z.string(),
  }),
  z.object({
    kind: z.literal("power-policy"),
    mode: z.string(),
    phase: z.string(),
    schedule: z.string(),
  }),
]);
const attentionSchema = z.object({
  id: z.string(),
  domain: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  observedAt: z.number(),
  summary: z.string(),
  nextAction: z.string(),
  projectId: z.string().optional(),
  presentation: attentionPresentationSchema.optional(),
});
const activeWorkSchema = z.object({
  id: z.string(),
  kind: z.enum(["work-order", "interactive"]),
  label: z.string(),
  status: z.enum(["running", "busy"]),
  startedAt: z.number(),
  projectId: z.string().optional(),
  taskKind: z.string().optional(),
  session: z.string().optional(),
});
const outcomeSchema = z.object({
  id: z.string(),
  domain: z.string(),
  label: z.string(),
  status: z.enum(["passed", "failed", "cancelled"]),
  endedAt: z.number(),
  projectId: z.string().optional(),
});
function boundedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number(),
    limit: z.number(),
    truncated: z.boolean(),
  });
}
const overviewSchema = z.object({
  health: z.object({
    status: z.enum(["healthy", "attention", "degraded"]),
    attentionCount: z.number(),
    degradedDomainCount: z.number(),
  }),
  attention: boundedSchema(attentionSchema),
  activeWork: boundedSchema(activeWorkSchema),
  automation: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      enabled: z.boolean(),
      configured: z.boolean(),
      activeCount: z.number(),
      tickMs: z.number().optional(),
      dependencies: z.record(z.string(), z.boolean()).optional(),
      lastOutcome: z.object({ status: outcomeSchema.shape.status, endedAt: z.number() }).optional(),
    }),
  ),
  runtimeDomains: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      status: z.enum(["healthy", "attention", "degraded", "disabled"]),
      summary: z.string(),
      errorKind: z.enum(["read-failed", "timeout"]).nullable(),
    }),
  ),
  operator: z.object({
    session: z.object({ state: z.enum(["ready", "attention", "disabled"]) }),
    skills: z.object({
      installed: z.number(),
      expected: z.number(),
      state: z.enum(["ready", "attention", "disabled"]),
    }),
    mcpProfiles: z.object({
      installed: z.number(),
      expected: z.number(),
      state: z.enum(["ready", "attention", "disabled"]),
      profiles: z.array(
        z.object({
          profile: z.enum(["observer", "home"]),
          role: z.enum(["observer", "home-operator"]),
          exposure: z.enum(["read-only", "controlled-operation"]),
          toolCount: z.number(),
          descriptorState: z.enum(["ready", "missing", "stale"]),
        }),
      ),
    }),
    promptLibrary: z.object({
      state: z.enum(["ready", "attention", "disabled", "configured", "degraded"]),
    }),
    optionalProjectMcpCount: z.number().nullable(),
  }),
  recentOutcomes: boundedSchema(outcomeSchema),
  degradedDomains: z.array(z.string()),
});
const statusDataSchema = z.object({
  generatedAt: z.number(),
  global: z.object({
    botUptimeMs: z.number().nullable(),
    version: z.string(),
    sessionCount: z.number(),
    runningCount: z.number(),
    busyCount: z.number(),
    queueDepth: z.number(),
    adapters: z.object({ telegram: z.boolean(), lark: z.boolean() }),
  }),
  sessions: z.array(sessionSchema),
  overview: overviewSchema.optional(),
});
const projectSchema = z
  .object({ sid: z.string(), label: z.string(), alive: z.boolean(), active: z.boolean() })
  .passthrough();
const loopReportsSchema = z.object({
  items: z.array(
    z.object({
      runId: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      status: z.enum(["passed", "failed"]),
      startedAt: z.number(),
      endedAt: z.number(),
      markdownPath: z.string(),
      summaryPath: z.string(),
      evalReportPath: z.string().optional(),
      evalOutcome: z
        .object({
          status: z.enum(["passed", "failed", "blocked", "not-run", "unknown"]),
          finalVerification: z.enum(["passed", "failed", "not-run", "unknown"]),
          reviewDecision: z.enum(["pass", "block", "fail"]).optional(),
          reason: z.string().optional(),
        })
        .optional(),
    }),
  ),
  total: z.number(),
  limit: z.number(),
  truncated: z.boolean(),
});
const scheduledTaskSchema = z.object({
  taskId: z.string(),
  source: z.enum([
    "loop-engineering",
    "article-monitor",
    "radar-monitor",
    "external-monitor",
    "launchd",
    "daily-audit",
    "autopilot-delegate",
  ]),
  name: z.string(),
  scheduledAt: z.number(),
  status: z.enum([
    "expected",
    "running",
    "success",
    "failed",
    "missing",
    "running-timeout",
    "skipped",
  ]),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  failureKind: z
    .enum([
      "agent-capacity",
      "dirty-worktree",
      "external-ci",
      "github-permission",
      "invalid-final-summary",
      "system-gate",
      "agent-timeout",
      "missing-instrumentation",
      "external-service",
      "unknown",
    ])
    .optional(),
  reportPath: z.string().optional(),
  repairStatus: z
    .enum([
      "not-needed",
      "pending",
      "running",
      "fixed",
      "blocked",
      "failed",
      "superseded",
      "not-reproducible",
    ])
    .optional(),
  updatedAt: z.number(),
});
const taskWindowSchema = z.object({ start: z.number(), end: z.number(), label: z.string() });
const dailyAuditSchema = z.object({
  observedAt: z.number(),
  lastFiredAt: z.number().nullable(),
  summary: z.object({
    window: taskWindowSchema.nullable(),
    counts: z.object({
      success: z.number(),
      failed: z.number(),
      missing: z.number(),
      running: z.number(),
      runningTimeout: z.number(),
      skipped: z.number(),
    }),
    items: z.array(scheduledTaskSchema),
  }),
  recentWindow: taskWindowSchema,
  recentRecords: z.array(scheduledTaskSchema),
  recentLimit: z.number(),
  recentTotal: z.number(),
  recentTruncated: z.boolean(),
});
const runtimeGuardianSchema = z.object({
  observedAt: z.number(),
  lookbackHours: z.number(),
  findings: z.array(
    z.object({
      kind: z.string(),
      severity: z.enum(["medium", "high"]),
      runId: z.string(),
      projectId: z.string(),
      projectPath: z.string(),
      evidence: z.array(z.string()),
      repairDisposition: z.enum(["bot-repairable", "target-or-external-blocker"]).optional(),
      runDir: z.string().optional(),
    }),
  ),
  total: z.number(),
  limit: z.number(),
  truncated: z.boolean(),
});

function response<T>(
  data: T,
  evidence: string[],
  options: { scope?: ObserverScope; nextSuggestedAction?: string | null } = {},
): ObserverToolResponse<T> {
  return {
    ok: true,
    role: "observer",
    capability: "read-only observation",
    data: tildeifyHomeDeep(data),
    evidence,
    blockedReason: null,
    scope: options.scope ?? { kind: "observation" },
    errorKind: null,
    nextSuggestedAction: options.nextSuggestedAction ?? null,
  };
}

function blocked(
  error: unknown,
  scope: ObserverScope,
  evidence: string[],
): ObserverToolResponse<never> {
  const message = error instanceof Error ? error.message : String(error);
  const errorKind = /not connected|disconnected|control|socket/i.test(message)
    ? "control-unavailable"
    : "read-failed";
  return {
    ok: false,
    role: "observer",
    capability: "read-only observation",
    data: null,
    evidence,
    blockedReason: errorKind,
    scope,
    errorKind,
    nextSuggestedAction: errorKind === "control-unavailable" ? "tcb service status" : "tcb doctor",
  };
}

function toolResult<T>(payload: ObserverToolResponse<T>) {
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

function statusNextAction(snapshot: DashboardSnapshot): string | null {
  if (snapshot.overview === undefined) return null;
  if (snapshot.overview.health.status === "degraded") return "tcb doctor";
  return snapshot.overview.attention.items[0]?.nextAction ?? null;
}

export function createObserverMcpServer(
  makeClient: () => ObserverClient = () => new ControlClient(),
  _deps: ObserverDeps = {},
  serverName = "tcb-observer",
): McpServer {
  const server = new McpServer({ name: serverName, version: appVersion() });

  server.registerTool(
    "tcb.observer.status",
    {
      title: "tmux-claude-bot Status",
      description: "Read global tmux-claude-bot status from the local control socket.",
      inputSchema: z.object({}),
      outputSchema: observerOutputSchema(statusDataSchema),
    },
    async () => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) => {
            const snapshot = await client.snapshot();
            return response(snapshot, ["control:snapshot"], {
              scope: { kind: "runtime-overview" },
              nextSuggestedAction: statusNextAction(snapshot),
            });
          }),
        );
      } catch (err) {
        return toolResult(blocked(err, { kind: "runtime-overview" }, ["control:snapshot"]));
      }
    },
  );

  server.registerTool(
    "tcb.observer.projects",
    {
      title: "tmux-claude-bot Projects",
      description: "Read known projects from the local control socket.",
      inputSchema: z.object({}),
      outputSchema: observerOutputSchema(z.array(projectSchema)),
    },
    async () => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response(await client.projects(), ["control:projects"], {
              scope: { kind: "projects" },
            }),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err, { kind: "projects" }, ["control:projects"]));
      }
    },
  );

  server.registerTool(
    "tcb.observer.sessions",
    {
      title: "tmux-claude-bot Sessions",
      description: "Read live session rows from the local control socket.",
      inputSchema: z.object({}),
      outputSchema: observerOutputSchema(z.array(sessionSchema)),
    },
    async () => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response((await client.snapshot()).sessions, ["control:snapshot.sessions"], {
              scope: { kind: "sessions" },
            }),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err, { kind: "sessions" }, ["control:snapshot.sessions"]));
      }
    },
  );

  server.registerTool(
    "tcb.observer.queue",
    {
      title: "tmux-claude-bot Queue",
      description: "Read queue and busy counts from the local control socket.",
      inputSchema: z.object({}),
      outputSchema: observerOutputSchema(
        z.object({
          queueDepth: z.number(),
          busyCount: z.number(),
          runningCount: z.number(),
          sessionCount: z.number(),
        }),
      ),
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
              { scope: { kind: "queue" } },
            );
          }),
        );
      } catch (err) {
        return toolResult(blocked(err, { kind: "queue" }, ["control:snapshot.global"]));
      }
    },
  );

  server.registerTool(
    "tcb.observer.logs_query",
    {
      title: "tmux-claude-bot Session Logs",
      description: "Read formatted WARN/ERROR logs scoped to one session.",
      inputSchema: z.object({ session: z.string().min(1) }),
      outputSchema: observerOutputSchema(z.object({ session: z.string(), text: z.string() })),
    },
    async ({ session }) => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response({ session, text: await client.logs(session) }, ["control:logs"], {
              scope: { kind: "session-logs", session },
            }),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err, { kind: "session-logs", session }, ["control:logs"]));
      }
    },
  );

  server.registerTool(
    "tcb.observer.loop_reports_list",
    {
      title: "tmux-claude-bot Loop Reports",
      description: "Read persisted Loop Engineering report records from state.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        projectId: z.string().min(1).optional(),
        status: z.enum(["passed", "failed"]).optional(),
      }),
      outputSchema: observerOutputSchema(loopReportsSchema),
    },
    async ({ limit, projectId, status }) => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response(
              await client.loopReports({
                limit: limit ?? 20,
                ...(projectId === undefined ? {} : { projectId }),
                ...(status === undefined ? {} : { status }),
              }),
              ["control:loop-reports"],
              {
                scope: {
                  kind: "loop-reports",
                  ...(projectId === undefined ? {} : { projectId }),
                },
              },
            ),
          ),
        );
      } catch (err) {
        return toolResult(
          blocked(
            err,
            {
              kind: "loop-reports",
              ...(projectId === undefined ? {} : { projectId }),
            },
            ["control:loop-reports"],
          ),
        );
      }
    },
  );

  server.registerTool(
    "tcb.observer.daily_task_audit",
    {
      title: "tmux-claude-bot Daily Task Audit",
      description: "Read Daily Task Audit ledger summaries without triggering audit or repair.",
      inputSchema: z.object({}),
      outputSchema: observerOutputSchema(dailyAuditSchema),
    },
    async () => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response(await client.dailyTaskAuditStatus(), ["control:daily-task-audit"], {
              scope: { kind: "daily-task-audit" },
            }),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err, { kind: "daily-task-audit" }, ["control:daily-task-audit"]));
      }
    },
  );

  server.registerTool(
    "tcb.observer.runtime_guardian_findings",
    {
      title: "tmux-claude-bot Runtime Guardian Findings",
      description: "Read current Runtime Guardian findings without dispatching repair.",
      inputSchema: z.object({
        lookbackHours: z.number().int().min(1).max(168).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: observerOutputSchema(runtimeGuardianSchema),
    },
    async ({ lookbackHours, limit }) => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response(
              await client.runtimeGuardianFindings({
                lookbackHours: lookbackHours ?? 24,
                limit: limit ?? 50,
              }),
              ["control:runtime-guardian-findings"],
              { scope: { kind: "runtime-guardian" } },
            ),
          ),
        );
      } catch (err) {
        return toolResult(
          blocked(err, { kind: "runtime-guardian" }, ["control:runtime-guardian-findings"]),
        );
      }
    },
  );

  return server;
}

export async function runObserverMcpServer(): Promise<void> {
  const server = createObserverMcpServer();
  await server.connect(new StdioServerTransport());
}
