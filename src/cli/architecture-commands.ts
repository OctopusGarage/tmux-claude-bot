import type { Command } from "commander";
import {
  runArchitectureQuarantineCommand,
  runTaskImplementationCommand,
} from "../core/loop/architecture-command.js";

import {
  TASK_IMPLEMENTATIONS,
  type TaskImplementationKind,
} from "../core/loop/task-implementation.js";

export function registerArchitectureCommands(loop: Command): void {
  for (const taskKind of Object.keys(TASK_IMPLEMENTATIONS) as TaskImplementationKind[]) {
    registerTaskImplementationCommands(loop, taskKind);
  }
}

function registerTaskImplementationCommands(loop: Command, taskKind: TaskImplementationKind): void {
  const { label, profile } = TASK_IMPLEMENTATIONS[taskKind];
  const family = loop
    .command(label)
    .description(`inspect and select single-project ${label} implementation (redacted JSON)`);
  const quarantine = family
    .command("quarantine")
    .description("inspect or explicitly reconcile durable external process ownership holds");
  quarantine
    .command("list")
    .action(() => print(runArchitectureQuarantineCommand({ action: "list" })));
  quarantine
    .command("release <workOrderId>")
    .option(
      "--processes-stopped",
      "explicitly confirm all external descendants stopped; known identities are rechecked",
    )
    .action((workOrderId: string, options: { processesStopped?: boolean }) =>
      print(
        runArchitectureQuarantineCommand({
          action: "release",
          workOrderId,
          processesStopped: options.processesStopped === true,
        }),
      ),
    );
  family
    .command("get <file> <projectId>")
    .description(`show the configured ${label} implementation with params redacted`)
    .action((file: string, projectId: string) => {
      print(runTaskImplementationCommand({ taskKind, action: "get", file, projectId }));
    });
  family
    .command("set <file> <projectId> <kind>")
    .description("explicitly select native or optional RalphWorks execution")
    .option("--profile <reference>", `RalphWorks profile reference (default ${profile})`)
    .option(
      "--runtime <reference>",
      "opaque RalphWorks runtime reference; credentials remain external",
    )
    .option(
      "--param <key=value>",
      "non-secret task parameter (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .action(
      (
        file: string,
        projectId: string,
        kind: string,
        options: { profile?: string; runtime?: string; param: string[] },
      ) => {
        try {
          const params = Object.fromEntries(
            options.param.map((entry) => {
              const index = entry.indexOf("=");
              if (index < 1) throw new Error("Use --param key=value");
              const raw = entry.slice(index + 1);
              const value =
                raw === "true"
                  ? true
                  : raw === "false"
                    ? false
                    : /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)
                      ? Number(raw)
                      : raw;
              return [entry.slice(0, index), value];
            }),
          );
          print(
            runTaskImplementationCommand({
              taskKind,
              action: "set",
              file,
              projectId,
              selection: {
                kind,
                ...(options.profile === undefined ? {} : { profile: options.profile }),
                ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
                ...(options.param.length === 0 ? {} : { params }),
              },
            }),
          );
        } catch {
          console.error("Invalid task parameters; use non-secret --param key=value entries.");
          process.exitCode = 1;
        }
      },
    );
}

function print(result: ReturnType<typeof runTaskImplementationCommand>): void {
  if (result.exitCode === 0) console.log(result.stdout);
  else {
    console.error(result.stderr);
    process.exitCode = result.exitCode;
  }
}
