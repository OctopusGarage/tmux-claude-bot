import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { tildeifyHomeDeep } from "../../shared/utils/path.js";
import { parseLoopConfigYaml, taskImplementationSchema } from "./config.js";
import {
  listLoopExecutionQuarantines,
  releaseLoopExecutionQuarantine,
} from "./execution-quarantine.js";
import type { LoopCommandResult } from "./loop-command.js";
import { TASK_IMPLEMENTATIONS, type TaskImplementationKind } from "./task-implementation.js";

/** Dedicated non-secret configuration boundary; external runtime files stay opaque. */
export function runArchitectureCommand(input: {
  action: "get" | "set";
  file: string;
  projectId: string;
  selection?: unknown;
}): LoopCommandResult {
  return runTaskImplementationCommand({ ...input, taskKind: "architecture" });
}

/** Select one task family without affecting other implementation choices. */
export function runTaskImplementationCommand(input: {
  taskKind: TaskImplementationKind;
  action: "get" | "set";
  file: string;
  projectId: string;
  selection?: unknown;
}): LoopCommandResult {
  try {
    if (!Object.hasOwn(TASK_IMPLEMENTATIONS, input.taskKind)) {
      throw new Error("unsupported implementation task family");
    }
    const { configKey } = TASK_IMPLEMENTATIONS[input.taskKind];
    const text = readFileSync(input.file, "utf8");
    const config = parseLoopConfigYaml(text);
    const project = config.projects.find((entry) => entry.id === input.projectId);
    if (project === undefined) throw new Error("unknown Loop Engineering project");
    let implementation = project.execution[configKey] ?? { kind: "native" as const };
    if (input.action === "set") {
      const parsed = taskImplementationSchema.safeParse(input.selection);
      if (!parsed.success) throw new Error("invalid task implementation configuration");
      implementation = parsed.data;
      const doc = parse(text) as {
        projects: Array<{ id: string; execution?: Record<string, unknown> }>;
      };
      const target = doc.projects.find((entry) => entry.id === input.projectId);
      if (target === undefined) throw new Error("unknown Loop Engineering project");
      target.execution = { ...target.execution, [configKey]: implementation };
      const next = stringify(doc);
      parseLoopConfigYaml(next);
      writeFileSync(input.file, next);
    }
    const safe =
      implementation.kind === "native"
        ? implementation
        : {
            ...implementation,
            ...(implementation.params === undefined
              ? {}
              : {
                  params: Object.fromEntries(
                    Object.keys(implementation.params).map((key) => [key, "<redacted>"]),
                  ),
                }),
          };
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        tildeifyHomeDeep({ projectId: input.projectId, implementation: safe }),
      ),
    };
  } catch {
    return {
      exitCode: 1,
      stderr: `${input.taskKind === "architecture" ? "Architecture" : "Task implementation"} configuration rejected; check the project, supervised execution, and non-secret selection.`,
    };
  }
}

export function runArchitectureQuarantineCommand(input: {
  action: "list" | "release";
  workOrderId?: string;
  processesStopped?: boolean;
}): LoopCommandResult {
  try {
    if (input.action === "release") {
      if (input.workOrderId === undefined) throw new Error("WorkOrder id required");
      releaseLoopExecutionQuarantine(input.workOrderId, input.processesStopped === true);
    }
    const items = listLoopExecutionQuarantines().map((record) => ({
      workOrderId: record.workOrderId,
      reason: record.reason,
      createdAt: record.createdAt,
      knownProcesses: record.processes.length,
    }));
    return { exitCode: 0, stdout: JSON.stringify({ items }) };
  } catch {
    return {
      exitCode: 1,
      stderr:
        "Quarantine retained. Confirm all external processes stopped; known live process identities must also be absent.",
    };
  }
}
