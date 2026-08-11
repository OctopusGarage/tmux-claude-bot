import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_PROFILES, type McpProfile, mcpProfilePath, mcpProfileSpec } from "../mcp/profiles.js";

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

export type AiToolReadiness = {
  skills: { installed: number; expected: number; state: "ready" | "attention" };
  mcpProfiles: { installed: number; expected: number; state: "ready" | "attention" };
};

type AiToolStatusProbes = {
  exists(path: string): boolean;
  read(path: string): string;
};

const defaultStatusProbes: AiToolStatusProbes = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
};

function validMcpProfile(path: string, profile: McpProfile, probes: AiToolStatusProbes): boolean {
  if (!probes.exists(path)) return false;
  try {
    const actual = JSON.parse(probes.read(path)) as Partial<ReturnType<typeof mcpProfileSpec>>;
    const expected = mcpProfileSpec(profile);
    return (
      actual.schemaVersion === expected.schemaVersion &&
      actual.profile === expected.profile &&
      actual.role === expected.role &&
      actual.exposure === expected.exposure &&
      Array.isArray(actual.tools) &&
      actual.tools.length === expected.tools.length &&
      expected.tools.every((tool) => actual.tools?.includes(tool))
    );
  } catch {
    return false;
  }
}

/** Path-free readiness for product-managed Home Operator skills and MCP profiles. */
export function readAiToolReadiness(
  homeDir: string,
  probes: AiToolStatusProbes = defaultStatusProbes,
): AiToolReadiness {
  const skillFiles = homeOperatorSkillFiles(homeDir);
  const mcpFiles = operatorHomeMcpProfileFiles(homeDir);
  const installedSkills = skillFiles.filter((file) => probes.exists(file.path)).length;
  const installedMcpProfiles = mcpFiles.filter(
    (file) => file.profile !== undefined && validMcpProfile(file.path, file.profile, probes),
  ).length;
  return {
    skills: {
      installed: installedSkills,
      expected: skillFiles.length,
      state: installedSkills === skillFiles.length ? "ready" : "attention",
    },
    mcpProfiles: {
      installed: installedMcpProfiles,
      expected: mcpFiles.length,
      state: installedMcpProfiles === mcpFiles.length ? "ready" : "attention",
    },
  };
}

/** Count repository-declared optional MCPs without inspecting client-private registrations. */
export function readOptionalProjectMcpCount(
  projectRoot: string,
  probes: Pick<AiToolStatusProbes, "exists" | "read"> = defaultStatusProbes,
): number {
  const file = join(projectRoot, ".mcp.json");
  if (!probes.exists(file)) return 0;
  try {
    const parsed = JSON.parse(probes.read(file)) as { mcpServers?: unknown };
    return parsed.mcpServers !== null &&
      typeof parsed.mcpServers === "object" &&
      !Array.isArray(parsed.mcpServers)
      ? Object.keys(parsed.mcpServers).length
      : 0;
  } catch {
    return 0;
  }
}
