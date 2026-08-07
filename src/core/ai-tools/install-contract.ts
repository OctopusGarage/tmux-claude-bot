import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_PROFILES, type McpProfile, mcpProfilePath } from "../mcp/profiles.js";

export const HOME_OPERATOR_SKILL_NAME = "tcb-home-operator";
export const LEGACY_HOME_OPERATOR_SKILL_NAME = "tmux-claude-bot";

export type AiToolClient = "claude" | "codex";
export type AiToolInstallScope = "operator-home" | "global";

export type AiToolExpectedFile = {
  role: "home-operator";
  surface: "skill" | "mcp";
  scope: AiToolInstallScope;
  client: AiToolClient | "mcp";
  profile?: McpProfile;
  path: string;
};

export function homeOperatorSkillFiles(
  home: string,
  scope: AiToolInstallScope = "operator-home",
): AiToolExpectedFile[] {
  return [
    {
      role: "home-operator",
      surface: "skill",
      scope,
      client: "claude",
      path: join(home, ".claude", "skills", HOME_OPERATOR_SKILL_NAME, "SKILL.md"),
    },
    {
      role: "home-operator",
      surface: "skill",
      scope,
      client: "codex",
      path: join(home, ".codex", "prompts", `${HOME_OPERATOR_SKILL_NAME}.md`),
    },
  ];
}

export function globalHomeOperatorSkillFiles(home: string = homedir()): AiToolExpectedFile[] {
  return homeOperatorSkillFiles(home, "global");
}

export function legacyGlobalHomeOperatorSkillFiles(home: string = homedir()): AiToolExpectedFile[] {
  return [
    {
      role: "home-operator",
      surface: "skill",
      scope: "global",
      client: "claude",
      path: join(home, ".claude", "skills", LEGACY_HOME_OPERATOR_SKILL_NAME, "SKILL.md"),
    },
    {
      role: "home-operator",
      surface: "skill",
      scope: "global",
      client: "codex",
      path: join(home, ".codex", "prompts", `${LEGACY_HOME_OPERATOR_SKILL_NAME}.md`),
    },
  ];
}

export function operatorHomeMcpProfileFiles(homeDir: string): AiToolExpectedFile[] {
  return MCP_PROFILES.map((profile) => ({
    role: "home-operator",
    surface: "mcp",
    scope: "operator-home",
    client: "mcp",
    profile,
    path: mcpProfilePath(homeDir, profile),
  }));
}

export function defaultOperatorHomeAiToolFiles(homeDir: string): AiToolExpectedFile[] {
  return [...homeOperatorSkillFiles(homeDir), ...operatorHomeMcpProfileFiles(homeDir)];
}
