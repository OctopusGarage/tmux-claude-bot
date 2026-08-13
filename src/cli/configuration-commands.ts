import type { Command } from "commander";

type CommandResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

type JsonOption = { json?: boolean };

async function printResult(load: () => Promise<CommandResult>): Promise<void> {
  const result = await load();
  if (result.exitCode === 0 && result.stdout !== undefined) {
    console.log(result.stdout);
    return;
  }
  console.error(result.stderr ?? "command failed without an error message");
  process.exitCode = result.exitCode;
}

/**
 * Register the personal-configuration and automation-control command family.
 * The composition root remains responsible only for choosing which command
 * families make up the public CLI.
 */
export function registerConfigurationCommands(program: Command): void {
  const configCommand = program
    .command("config")
    .description("inspect and safely edit non-secret personal configuration");

  configCommand
    .command("list")
    .description("list .env configuration with secrets redacted")
    .option("--json", "output config entries as JSON")
    .action(async (options: JsonOption) => {
      await printResult(async () => {
        const { runConfigCommand } = await import("../core/config/command.js");
        return runConfigCommand(["list", ...(options.json ? ["--json"] : [])]);
      });
    });

  configCommand
    .command("get <key>")
    .description("show one .env configuration value with secrets redacted")
    .option("--json", "output config entry as JSON")
    .action(async (key: string, options: JsonOption) => {
      await printResult(async () => {
        const { runConfigCommand } = await import("../core/config/command.js");
        return runConfigCommand(["get", key, ...(options.json ? ["--json"] : [])]);
      });
    });

  configCommand
    .command("set <key> <value>")
    .description("set an allowlisted non-secret .env configuration value")
    .option("--json", "output set result as JSON")
    .action(async (key: string, value: string, options: JsonOption) => {
      await printResult(async () => {
        const { runConfigCommand } = await import("../core/config/command.js");
        return runConfigCommand(["set", key, value, ...(options.json ? ["--json"] : [])]);
      });
    });

  const automation = program
    .command("automation")
    .description("inspect and pause or resume high-cost background automation");

  automation
    .command("status")
    .description("show Loop Engineering, task audit, and runtime guardian state")
    .option("--json", "output automation status as JSON")
    .action(async (options: JsonOption) => {
      await printResult(async () => {
        const { runAutomationCommand } = await import("../core/config/command.js");
        return runAutomationCommand(["status", ...(options.json ? ["--json"] : [])]);
      });
    });

  for (const action of ["pause", "resume"] as const) {
    automation
      .command(`${action} <target>`)
      .description(`${action} loop, task-audit, or runtime-guardian automation`)
      .option("--json", "output toggle result as JSON")
      .action(async (target: string, options: JsonOption) => {
        await printResult(async () => {
          const { runAutomationCommand } = await import("../core/config/command.js");
          return runAutomationCommand([action, target, ...(options.json ? ["--json"] : [])]);
        });
      });
  }

  const capacity = automation
    .command("capacity")
    .description("inspect agent capacity and autonomous admission evidence");
  capacity
    .command("status")
    .option("--json", "output agent capacity status as JSON")
    .action(async (options: JsonOption) => {
      await printResult(async () => {
        const { runAgentCapacityCommand } = await import("../core/automation/capacity-command.js");
        return runAgentCapacityCommand(["status", ...(options.json ? ["--json"] : [])]);
      });
    });
  capacity
    .command("history")
    .option("--since <time>", "look back from now (ISO, epoch ms, or 30m|2h|1d)", "24h")
    .option("--json", "output bounded admission history as JSON")
    .action(async (options: { since: string; json?: boolean }) => {
      await printResult(async () => {
        const { runAgentCapacityCommand } = await import("../core/automation/capacity-command.js");
        return runAgentCapacityCommand([
          "history",
          "--since",
          options.since,
          ...(options.json ? ["--json"] : []),
        ]);
      });
    });
}
