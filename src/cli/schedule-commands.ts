import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { ControlClient } from "../adapters/control/client.js";
import type { ScheduledMessageRecord } from "../core/scheduled-messages/types.js";
import { tildeifyHome, tildeifyHomeDeep } from "../shared/utils/path.js";
import { matchRef } from "./control.js";

type ScheduleClient = Pick<
  ControlClient,
  | "connect"
  | "close"
  | "scheduleCreate"
  | "scheduledMessages"
  | "scheduledMessage"
  | "cancelScheduledMessage"
> & {
  snapshot(): Promise<{ sessions: { session: string; label: string }[] }>;
};

function render(record: ScheduledMessageRecord): string {
  return `${record.id} | ${record.status} | ${new Date(record.dueAt).toISOString()} | ${record.target.label}\n${record.text}${record.error ? `\n${record.error}` : ""}${record.result ? `\n${record.result}` : ""}`;
}

export function registerScheduleCommands(
  program: Command,
  factory: () => ScheduleClient = () => new ControlClient(),
): void {
  const schedule = program
    .command("schedule")
    .description("schedule one-time session messages and inspect or cancel them");
  async function run(
    json: boolean | undefined,
    operation: (
      client: ScheduleClient,
    ) => Promise<ScheduledMessageRecord | ScheduledMessageRecord[]>,
  ): Promise<void> {
    const client = factory();
    try {
      await client.connect();
      const result = await operation(client);
      if (json) console.log(JSON.stringify(tildeifyHomeDeep(result), null, 2));
      else
        console.log(
          tildeifyHome(
            Array.isArray(result)
              ? result.map(render).join("\n\n") || "No scheduled messages."
              : render(result),
          ),
        );
    } catch (error) {
      throw new Error(tildeifyHome(error instanceof Error ? error.message : String(error)));
    } finally {
      client.close();
    }
  }
  schedule
    .command("create")
    .description("send text to a selected session at a future time")
    .requiredOption("--session <session>", "target session name or unique friendly label")
    .option("--at <time>", "ISO timestamp with UTC offset or Z")
    .option("--in <duration>", "positive delay, such as 30m, 2h or 1d")
    .requiredOption("--text <text>", "instruction text; quote multiline content")
    .option("--json", "output the saved schedule as JSON")
    .action(
      async (options: {
        session: string;
        at?: string;
        in?: string;
        text: string;
        json?: boolean;
      }) => {
        if (Boolean(options.at) === Boolean(options.in))
          throw new Error("supply exactly one of --at or --in");
        if (options.at && !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(options.at))
          throw new Error("--at requires an ISO timestamp with UTC offset or Z");
        if (options.in && !/^\d+(?:m|h|d)$/.test(options.in))
          throw new Error("--in requires a positive duration such as 30m, 2h or 1d");
        if (!options.text.trim()) throw new Error("message text is required");
        const when = options.at ?? options.in;
        if (when === undefined) throw new Error("send time is required");
        await run(options.json, async (client) => {
          const snapshot = await client.snapshot();
          const target = matchRef(
            snapshot.sessions,
            options.session,
            (row) => row.session,
            (row) => row.label || row.session,
            "session",
            "tcb sessions",
          );
          return client.scheduleCreate(target.session, when, options.text, randomUUID());
        });
      },
    );
  schedule
    .command("list")
    .description("list saved scheduled messages")
    .option("--json", "output JSON")
    .action(async (options: { json?: boolean }) =>
      run(options.json, (client) => client.scheduledMessages()),
    );
  schedule
    .command("show <id>")
    .description("inspect a scheduled message")
    .option("--json", "output JSON")
    .action(async (id: string, options: { json?: boolean }) =>
      run(options.json, (client) => client.scheduledMessage(id)),
    );
  schedule
    .command("cancel <id>")
    .description("cancel a scheduled message before submission")
    .option("--json", "output JSON")
    .action(async (id: string, options: { json?: boolean }) =>
      run(options.json, (client) => client.cancelScheduledMessage(id)),
    );
}
