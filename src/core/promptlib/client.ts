/** Stdio MCP client for forge-mcp-server. Lazily connects with a rebuildable cache. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLogger } from "../../shared/utils/logger.js";

const log = createLogger("promptlib.client");

export interface PromptMcpConfig {
  command: string; // Empty means disabled.
  args: string[];
  cwd?: string;
}

/** Enabled only when a start command is configured. */
export function promptLibEnabled(cfg: PromptMcpConfig): boolean {
  return cfg.command.trim().length > 0;
}

let cached: Client | null = null;
let connecting: Promise<Client> | null = null;

function dropClient(): void {
  const c = cached;
  cached = null;
  if (c) void c.close().catch(() => undefined);
}

async function getClient(cfg: PromptMcpConfig): Promise<Client> {
  if (cached) return cached;
  if (connecting) return connecting;
  connecting = (async () => {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    });
    const client = new Client({ name: "tmux-claude-bot", version: "1" }, { capabilities: {} });
    await client.connect(transport);
    cached = client;
    log.info("prompt-lib MCP connected", { data: { command: cfg.command } });
    return client;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Call one tool and return joined text content. Drop the cache on failure. */
export async function callPromptTool(
  cfg: PromptMcpConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const client = await getClient(cfg);
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  } catch (err) {
    log.warn("prompt-lib call failed; dropping client", { err, data: { tool: name } });
    dropClient();
    throw err;
  }
}
