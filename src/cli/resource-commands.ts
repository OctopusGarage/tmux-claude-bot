import type { Command } from "commander";

type Result = { exitCode: number; stdout?: string; stderr?: string };
type JsonOption = { json?: boolean };

async function printResult(load: () => Promise<Result>): Promise<void> {
  const result = await load();
  if (result.exitCode === 0 && result.stdout !== undefined) console.log(result.stdout);
  else {
    console.error(result.stderr ?? "resource command failed");
    process.exitCode = result.exitCode;
  }
}

/** Register the bounded Resource Guardian operator command family. */
export function registerResourceCommands(program: Command): void {
  const resource = program
    .command("resource")
    .description("inspect Resource Guardian pressure state and set its safe live overrides");
  resource
    .command("status")
    .option("--json", "output JSON")
    .action(async (options: JsonOption) => {
      await printResult(async () => {
        const { runResourceGuardianCommand } = await import("../core/resource-guardian/command.js");
        return runResourceGuardianCommand(["status", ...(options.json ? ["--json"] : [])]);
      });
    });
  resource
    .command("incidents")
    .option("--limit <count>", "maximum incidents to return")
    .option("--json", "output JSON")
    .action(async (options: { limit?: string; json?: boolean }) => {
      await printResult(async () => {
        const { runResourceGuardianCommand } = await import("../core/resource-guardian/command.js");
        return runResourceGuardianCommand([
          "incidents",
          ...(options.limit ? ["--limit", options.limit] : []),
          ...(options.json ? ["--json"] : []),
        ]);
      });
    });
  for (const field of ["mode", "profile"] as const) {
    resource
      .command(`${field} <value>`)
      .option("--json", "output JSON")
      .action(async (value: string, options: JsonOption) => {
        await printResult(async () => {
          const { runResourceGuardianCommand } = await import(
            "../core/resource-guardian/command.js"
          );
          return runResourceGuardianCommand([field, value, ...(options.json ? ["--json"] : [])]);
        });
      });
  }
}
