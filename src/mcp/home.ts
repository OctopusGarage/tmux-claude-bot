import { z } from "zod";
import { ControlClient } from "../adapters/control/client.js";
import { HOME_MCP_TOOLS } from "../core/mcp/profiles.js";
import { tildeifyHomeDeep } from "../shared/utils/path.js";
import { createObserverMcpServer, type ObserverClient, type ObserverDeps } from "./observer.js";

type HomeClient = ObserverClient & Pick<ControlClient, "autopilot" | "send">;

const homeScopeSchema = z.object({
  kind: z.literal("controlled-operation"),
  session: z.string(),
});

type HomeScope = z.infer<typeof homeScopeSchema>;

type HomeToolResponse<T> = {
  ok: boolean;
  role: "home";
  capability: "controlled operation";
  data: T | null;
  evidence: string[];
  blockedReason: string | null;
  scope: HomeScope;
  errorKind: "control-unavailable" | "operation-blocked" | null;
  nextSuggestedAction: string | null;
};

export { HOME_MCP_TOOLS };

function homeOutputSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    ok: z.boolean(),
    role: z.literal("home"),
    capability: z.literal("controlled operation"),
    data: data.nullable(),
    evidence: z.array(z.string()),
    blockedReason: z.string().nullable(),
    scope: homeScopeSchema,
    errorKind: z.enum(["control-unavailable", "operation-blocked"]).nullable(),
    nextSuggestedAction: z.string().nullable(),
  });
}

function response<T>(data: T, evidence: string[], scope: HomeScope): HomeToolResponse<T> {
  return {
    ok: true,
    role: "home",
    capability: "controlled operation",
    data: tildeifyHomeDeep(data),
    evidence,
    blockedReason: null,
    scope,
    errorKind: null,
    nextSuggestedAction: null,
  };
}

function blocked(error: unknown, scope: HomeScope, evidence: string[]): HomeToolResponse<never> {
  const message = error instanceof Error ? error.message : String(error);
  const errorKind = /not connected|disconnected|control|socket/i.test(message)
    ? "control-unavailable"
    : "operation-blocked";
  return {
    ok: false,
    role: "home",
    capability: "controlled operation",
    data: null,
    evidence,
    blockedReason: errorKind,
    scope,
    errorKind,
    nextSuggestedAction: errorKind === "control-unavailable" ? "tcb service status" : null,
  };
}

function toolResult<T>(payload: HomeToolResponse<T>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function withClient<T>(
  makeClient: () => HomeClient,
  fn: (client: HomeClient) => Promise<T>,
): Promise<T> {
  const client = makeClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function delegationVerb(requirement: string): string {
  const trimmed = requirement.trim();
  if (trimmed.length === 0) return "delegate";
  return /^delegate\b/i.test(trimmed) ? trimmed : `delegate ${trimmed}`;
}

export function createHomeMcpServer(
  makeClient: () => HomeClient = () => new ControlClient(),
  observerDeps: ObserverDeps = {},
) {
  const server = createObserverMcpServer(makeClient, observerDeps, "tcb-home-operator");

  server.registerTool(
    "tcb.home.send_prompt",
    {
      title: "tmux-claude-bot Send Prompt",
      description:
        "Send an owner prompt to an explicit session through the control socket and queue gates.",
      inputSchema: z.object({
        session: z.string().min(1),
        text: z.string().min(1),
      }),
      outputSchema: homeOutputSchema(
        z.object({
          session: z.string(),
          result: z.object({ status: z.string() }).passthrough(),
        }),
      ),
    },
    async ({ session, text }) => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response(
              {
                session,
                result: await client.send(session, text),
              },
              ["control:send", "control:queue-gate"],
              { kind: "controlled-operation", session },
            ),
          ),
        );
      } catch (err) {
        return toolResult(
          blocked(err, { kind: "controlled-operation", session }, [
            "control:send",
            "control:queue-gate",
          ]),
        );
      }
    },
  );

  server.registerTool(
    "tcb.home.delegate_autopilot",
    {
      title: "tmux-claude-bot Delegate Autopilot",
      description:
        "Delegate a requirement to Autopilot for an explicit session through existing WorkOrder gates.",
      inputSchema: z.object({
        session: z.string().min(1),
        requirement: z.string().default(""),
      }),
      outputSchema: homeOutputSchema(
        z.object({
          session: z.string(),
          requirement: z.string(),
          result: z.object({ status: z.string() }).passthrough(),
        }),
      ),
    },
    async ({ session, requirement }) => {
      try {
        return toolResult(
          await withClient(makeClient, async (client) =>
            response(
              {
                session,
                requirement,
                result: await client.autopilot(session, delegationVerb(requirement)),
              },
              ["control:autopilot", "control:work-order-gate"],
              { kind: "controlled-operation", session },
            ),
          ),
        );
      } catch (err) {
        return toolResult(
          blocked(err, { kind: "controlled-operation", session }, [
            "control:autopilot",
            "control:work-order-gate",
          ]),
        );
      }
    },
  );

  return server;
}

export async function runHomeMcpServer(): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createHomeMcpServer();
  await server.connect(new StdioServerTransport());
}
