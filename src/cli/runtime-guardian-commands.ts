import type { Command } from "commander";
import { ControlClient } from "../adapters/control/client.js";
import { tildeifyHome, tildeifyHomeDeep } from "../shared/utils/path.js";

type RuntimeGuardianFindingsView = Awaited<ReturnType<ControlClient["runtimeGuardianFindings"]>>;
type RuntimeGuardianFindingsClient = Pick<ControlClient, "runtimeGuardianFindings">;

type RuntimeGuardianFindingsCliOpts = {
  project?: string;
  limit?: string;
  lookbackHours?: string;
  json?: boolean;
};

type RuntimeGuardianCommandDeps = {
  withClient?: <T>(fn: (client: ControlClient) => Promise<T>) => Promise<T>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exit?: (code: number) => never;
};
type RuntimeGuardianFindingsRunner = (opts: RuntimeGuardianFindingsCliOpts) => Promise<void>;

const NOT_RUNNING =
  "Can't reach the bot's control socket — is it running?  start it: tcb service start\n";

function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

/* c8 ignore start -- real control-socket process glue; command behavior is covered with injected deps. */
async function defaultWithClient<T>(fn: (client: ControlClient) => Promise<T>): Promise<T> {
  const client = new ControlClient();
  try {
    await client.connect();
  } catch {
    process.stderr.write(NOT_RUNNING);
    process.exit(1);
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
/* c8 ignore stop */

function fail(err: unknown, deps: RuntimeGuardianCommandDeps): never {
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  stderr(`${err instanceof Error ? err.message : String(err)}\n`);
  return exit(1);
}

export async function readRuntimeGuardianFindingsForCli(
  client: RuntimeGuardianFindingsClient,
  opts: RuntimeGuardianFindingsCliOpts,
): Promise<RuntimeGuardianFindingsView> {
  const limit = parsePositiveInteger(opts.limit, "--limit");
  const lookbackHours = parsePositiveInteger(opts.lookbackHours, "--lookback-hours");
  return await client.runtimeGuardianFindings({
    ...(opts.project === undefined ? {} : { projectId: opts.project }),
    ...(limit === undefined ? {} : { limit }),
    ...(lookbackHours === undefined ? {} : { lookbackHours }),
  });
}

export function formatRuntimeGuardianFindings(view: RuntimeGuardianFindingsView): string {
  if (view.findings.length === 0) {
    return `Runtime Guardian findings: none in the last ${view.lookbackHours}h`;
  }
  const lines = [
    `Runtime Guardian findings: ${view.total}${view.truncated ? ` (showing ${view.limit})` : ""}`,
  ];
  for (const finding of view.findings) {
    lines.push(`- ${finding.projectId} · ${finding.kind} · ${finding.severity}`);
    lines.push(`  runId: ${finding.runId}`);
    const firstEvidence = finding.evidence[0];
    if (firstEvidence !== undefined) {
      lines.push(`  evidence: ${tildeifyHome(firstEvidence)}`);
    }
  }
  return lines.join("\n");
}

export async function cmdRuntimeGuardianFindings(
  opts: RuntimeGuardianFindingsCliOpts,
  deps: RuntimeGuardianCommandDeps = {},
): Promise<void> {
  const withClient = deps.withClient ?? defaultWithClient;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  await withClient(async (client) => {
    const result = await readRuntimeGuardianFindingsForCli(client, opts);
    stdout(
      opts.json
        ? JSON.stringify(tildeifyHomeDeep(result), null, 2)
        : formatRuntimeGuardianFindings(result),
    );
  }).catch((err: unknown) => fail(err, deps));
}

export function registerRuntimeGuardianCommands(
  program: Command,
  runFindings: RuntimeGuardianFindingsRunner = cmdRuntimeGuardianFindings,
): void {
  const runtimeGuardian = program
    .command("runtime-guardian")
    .description("inspect Runtime Guardian read-only findings");

  runtimeGuardian
    .command("findings")
    .description("list current Runtime Guardian findings without dispatching repair")
    .option("--project <id>", "filter findings by project id")
    .option("--limit <n>", "maximum findings to show", "20")
    .option("--lookback-hours <n>", "hours of Runtime Guardian artifacts to inspect")
    .option("--json", "output JSON")
    .action(async (options: RuntimeGuardianFindingsCliOpts) => {
      await runFindings(options);
    });
}
