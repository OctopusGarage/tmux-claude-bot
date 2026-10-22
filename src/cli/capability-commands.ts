import type { Command } from "commander";

type Options = { json?: boolean; default?: boolean; task?: string };

async function run(args: string[]): Promise<void> {
  const { runCapabilitiesCommand } = await import("../core/capabilities/command.js");
  const result = runCapabilitiesCommand(args);
  if (result.exitCode === 0) console.log(result.stdout);
  else {
    console.error(result.stderr);
    process.exitCode = result.exitCode;
  }
}

/** Register the curated external-capability command family. */
export function registerCapabilityCommands(program: Command): void {
  const capabilities = program
    .command("capabilities")
    .description("inspect curated external skills and task capability dependencies");
  capabilities
    .command("list")
    .description("list the curated default capability catalog")
    .option("--json", "output capability catalog as JSON")
    .action(async (o: Options) => run(["list", ...(o.json ? ["--json"] : [])]));
  capabilities
    .command("status")
    .description("show task-specific capability readiness")
    .requiredOption("--task <taskKind>", "Loop WorkOrder task kind")
    .option("--json", "output capability status as JSON")
    .action(async (o: Options) =>
      run(["status", "--task", o.task ?? "", ...(o.json ? ["--json"] : [])]),
    );
  for (const action of ["install", "update"] as const)
    capabilities
      .command(action)
      .description(
        `print the default approved-skill ${action === "install" ? "install plan" : "refresh path"} for curated capabilities`,
      )
      .option("--default", "use the repo-maintained default capability catalog")
      .option("--json", `output capability ${action} plan as JSON`)
      .action(async (o: Options) =>
        run([action, ...(o.default ? ["--default"] : []), ...(o.json ? ["--json"] : [])]),
      );
}
