import { z } from "zod";
import { ControlClient } from "../adapters/control/client.js";
import { HOME_MCP_TOOLS } from "../core/mcp/profiles.js";
import { createObserverMcpServer, type ObserverClient, type ObserverDeps } from "./observer.js";

type HomeClient = ObserverClient & Pick<ControlClient, "autopilot" | "send">;

type HomeToolResponse = {
  ok: boolean;
  role: "home";
  capability: "controlled operation";
  data: unknown;
  evidence: string[];
  blockedReason: string | null;
};

export { HOME_MCP_TOOLS };

function response(data: unknown, evidence: string[]): HomeToolResponse {
  return {
    ok: true,
    role: "home",
    capability: "controlled operation",
    data,
    evidence,
    blockedReason: null,
  };
}

function blocked(error: unknown): HomeToolResponse {
  return {
    ok: false,
    role: "home",
    capability: "controlled operation",
    data: null,
    evidence: [],
    blockedReason: error instanceof Error ? error.message : String(error),
  };
}

function toolResult(payload: HomeToolResponse) {
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
  const server = createObserverMcpServer(makeClient, observerDeps);

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
            ),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err));
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
            ),
          ),
        );
      } catch (err) {
        return toolResult(blocked(err));
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
