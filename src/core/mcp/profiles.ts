import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type McpProfile = "observer" | "home";

export type McpProfileSpec = {
  schemaVersion: 1;
  profile: McpProfile;
  role: "observer" | "home-operator";
  exposure: "read-only" | "controlled-operation";
  server: {
    transport: "stdio";
    command: string;
    args: string[];
  };
  tools: string[];
  boundaries: string[];
};

export type McpInstallResult = {
  profile: McpProfile;
  path: string;
  command: string;
  args: string[];
};

export const MCP_PROFILES = ["observer", "home"] as const satisfies readonly McpProfile[];
export const OBSERVER_MCP_TOOLS = [
  "tcb.observer.status",
  "tcb.observer.projects",
  "tcb.observer.sessions",
  "tcb.observer.queue",
  "tcb.observer.logs_query",
  "tcb.observer.loop_reports_list",
  "tcb.observer.daily_task_audit",
  "tcb.observer.runtime_guardian_findings",
] as const;
export const HOME_MCP_TOOLS = ["tcb.home.send_prompt", "tcb.home.delegate_autopilot"] as const;

function profileTools(profile: McpProfile): string[] {
  if (profile === "observer") return [...OBSERVER_MCP_TOOLS];
  return [...OBSERVER_MCP_TOOLS, ...HOME_MCP_TOOLS];
}

export function mcpProfileSpec(profile: McpProfile, command = "tmux-claude-bot"): McpProfileSpec {
  return {
    schemaVersion: 1,
    profile,
    role: profile === "observer" ? "observer" : "home-operator",
    exposure: profile === "observer" ? "read-only" : "controlled-operation",
    server: {
      transport: "stdio",
      command,
      args: ["mcp", profile],
    },
    tools: profileTools(profile),
    boundaries:
      profile === "observer"
        ? ["No mutation, prompt delivery, delegation, repair, repository writes, or PR operations."]
        : [
            "Requires explicit target session.",
            "Uses existing control-service queue, conflict, and WorkOrder gates.",
            "No arbitrary shell execution, direct file edits, PR merge operations, or WorkOrder internals.",
          ],
  };
}

export function parseMcpProfile(value: string): McpProfile | null {
  return MCP_PROFILES.includes(value as McpProfile) ? (value as McpProfile) : null;
}

export function mcpProfilePath(homeDir: string, profile: McpProfile): string {
  return join(homeDir, "mcp", `${profile}.json`);
}

export function installMcpProfiles(opts: {
  homeDir: string;
  profiles: McpProfile[];
  command?: string;
}): McpInstallResult[] {
  const mcpDir = join(opts.homeDir, "mcp");
  mkdirSync(mcpDir, { recursive: true });
  return opts.profiles.map((profile) => {
    const spec = mcpProfileSpec(profile, opts.command);
    const path = mcpProfilePath(opts.homeDir, profile);
    writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
    return {
      profile,
      path,
      command: spec.server.command,
      args: spec.server.args,
    };
  });
}
