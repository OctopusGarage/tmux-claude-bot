import type { Command } from "commander";

type CommandResult = { exitCode: number; stdout?: string; stderr?: string };

async function printResult(load: () => Promise<CommandResult>): Promise<void> {
  const result = await load();
  if (result.exitCode === 0 && result.stdout !== undefined) console.log(result.stdout);
  else {
    console.error(result.stderr ?? "power command failed");
    process.exitCode = result.exitCode;
  }
}

/** Register explicit host-power inspection and macOS wake-schedule management. */
export function registerPowerCommands(program: Command): void {
  const power = program
    .command("power")
    .description("inspect host reachability and manage the fixed macOS wake schedule");
  power
    .command("status")
    .option("--json", "output JSON")
    .action(async (options: { json?: boolean }) => {
      await printResult(async () => {
        const { runPowerCommand } = await import("../core/platform/power-command.js");
        return runPowerCommand(["status", ...(options.json ? ["--json"] : [])]);
      });
    });

  const schedule = power.command("schedule").description("manage the exact fixed daily wake");
  for (const action of ["install", "remove"] as const) {
    schedule.command(action).action(async () => {
      await printResult(async () => {
        const { runPowerCommand } = await import("../core/platform/power-command.js");
        return runPowerCommand(["schedule", action]);
      });
    });
  }
}
