import { LOOP_WORK_ORDER_TASK_KINDS, type LoopWorkOrderTaskKind } from "../loop/task-family.js";
import { listAgentSkills } from "../skills/registry.js";
import {
  capabilityInstallPlan,
  capabilityStatusForTaskFamily,
  DEFAULT_CAPABILITY_CATALOG,
} from "./catalog.js";

export type CapabilitiesCommandResult =
  | { exitCode: number; stdout: string; stderr?: never }
  | { exitCode: number; stderr: string; stdout?: never };

function isTaskKind(value: string): value is LoopWorkOrderTaskKind {
  return (LOOP_WORK_ORDER_TASK_KINDS as readonly string[]).includes(value);
}

function renderCatalogText(): string {
  return [
    `capabilities: ${DEFAULT_CAPABILITY_CATALOG.length} curated`,
    ...DEFAULT_CAPABILITY_CATALOG.map(
      (capability) =>
        `- ${capability.id}: ${capability.title} (${capability.type}, ${capability.installScope})`,
    ),
  ].join("\n");
}

function renderStatusText(input: {
  taskKind: LoopWorkOrderTaskKind;
  capabilities: ReturnType<typeof capabilityStatusForTaskFamily>;
}): string {
  if (input.capabilities.length === 0) {
    return `capabilities status: ${input.taskKind} has no external capability dependencies`;
  }
  return [
    `capabilities status: ${input.taskKind}`,
    ...input.capabilities.map((capability) => {
      const state = capability.installed
        ? "installed"
        : capability.blocking
          ? "missing-required"
          : "missing-recommended";
      return `- ${capability.capabilityId}: ${state} (${capability.level}, ${capability.phase})`;
    }),
  ].join("\n");
}

function renderInstallPlanText(plan: ReturnType<typeof capabilityInstallPlan>): string {
  return [
    `capabilities install plan: ${plan.actions.length} action(s), ${plan.approvedSkills.length} approved skill(s)`,
    ...plan.actions.map(
      (action) =>
        `- ${action.action} ${action.capabilityId}${action.skillId ? ` -> ${action.skillId}` : ""}: ${action.reason}`,
    ),
    "next:",
    ...plan.nextCommands.map((command) => `- ${command}`),
  ].join("\n");
}

function renderUpdatePlanText(): string {
  return [
    "capabilities update plan: refresh pinned approved skill metadata, then sync explicitly",
    "- tcb loop skills refresh <file> --write",
    "- tcb loop skills sync <file>",
    "- Restart affected Claude Code / Codex sessions so refreshed skills are discoverable.",
  ].join("\n");
}

export function runCapabilitiesCommand(args: string[]): CapabilitiesCommandResult {
  const action = args[0] ?? "status";
  if (action === "list") {
    const json = args.includes("--json");
    const unexpected = args.slice(1).find((arg) => arg !== "--json");
    if (unexpected !== undefined) {
      return { exitCode: 1, stderr: `unknown capabilities list option "${unexpected}"` };
    }
    return {
      exitCode: 0,
      stdout: json ? JSON.stringify(DEFAULT_CAPABILITY_CATALOG) : renderCatalogText(),
    };
  }

  if (action === "status") {
    const json = args.includes("--json");
    const taskIndex = args.indexOf("--task");
    const taskKind = taskIndex >= 0 ? args[taskIndex + 1] : undefined;
    if (taskKind === undefined || !isTaskKind(taskKind)) {
      return {
        exitCode: 1,
        stderr: "Usage: capabilities status --task <taskKind> [--json]",
      };
    }
    const capabilities = capabilityStatusForTaskFamily(taskKind, listAgentSkills());
    const result = { taskKind, capabilities };
    return {
      exitCode: 0,
      stdout: json ? JSON.stringify(result) : renderStatusText(result),
    };
  }

  if (action === "install") {
    const json = args.includes("--json");
    if (!args.includes("--default")) {
      return {
        exitCode: 1,
        stderr: "Usage: capabilities install --default [--json]",
      };
    }
    const installedSkillIds = listAgentSkills().map((skill) => skill.skillId);
    const plan = capabilityInstallPlan({ scope: "default", installedSkillIds });
    return {
      exitCode: 0,
      stdout: json ? JSON.stringify(plan) : renderInstallPlanText(plan),
    };
  }

  if (action === "update") {
    const json = args.includes("--json");
    if (!args.includes("--default")) {
      return {
        exitCode: 1,
        stderr: "Usage: capabilities update --default [--json]",
      };
    }
    const result = {
      scope: "default",
      nextCommands: [
        "tcb loop skills refresh <file> --write",
        "tcb loop skills sync <file>",
        "Restart affected Claude Code / Codex sessions so refreshed skills are discoverable.",
      ],
    };
    return {
      exitCode: 0,
      stdout: json ? JSON.stringify(result) : renderUpdatePlanText(),
    };
  }

  return {
    exitCode: 1,
    stderr:
      "Usage: capabilities list [--json] | capabilities status --task <taskKind> [--json] | capabilities install --default [--json] | capabilities update --default [--json]",
  };
}
