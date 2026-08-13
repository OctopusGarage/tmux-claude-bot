import { tildeifyHomeDeep } from "../../shared/utils/path.js";
import { parseSince } from "../logs/log-query.js";
import { readAutomationAdmissionEvents } from "./admission-events.js";
import { AgentCapacityStore } from "./capacity-store.js";
import { AutomationOccurrenceStore } from "./occurrence-window.js";

type CommandResult =
  | { exitCode: 0; stdout: string; stderr?: never }
  | { exitCode: 1; stderr: string; stdout?: never };

type CapacityCommandOptions = {
  now?: () => number;
  capacity?: AgentCapacityStore;
  occurrences?: AutomationOccurrenceStore;
};

const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

function json(value: unknown): string {
  return JSON.stringify(tildeifyHomeDeep(value));
}

function parseHistoryArgs(args: string[], now: number): { since: number; json: boolean } | string {
  let since = now - 24 * 60 * 60_000;
  let jsonOutput = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
    if (arg === "--since") {
      const value = args[index + 1];
      if (value === undefined) return "--since requires a value";
      since = parseSince(value, now);
      index += 1;
      continue;
    }
    return `unknown option "${arg}"`;
  }
  if (since > now) return "--since must not be in the future";
  if (now - since > MAX_LOOKBACK_MS) return "--since must be within the last 30 days";
  return { since, json: jsonOutput };
}

export function runAgentCapacityCommand(
  args: string[],
  options: CapacityCommandOptions = {},
): CommandResult {
  const now = (options.now ?? Date.now)();
  try {
    if (args[0] === "status") {
      const rest = args.slice(1);
      if (rest.some((arg) => arg !== "--json")) return { exitCode: 1, stderr: "unknown option" };
      const capacity = options.capacity ?? new AgentCapacityStore();
      const occurrences = (options.occurrences ?? new AutomationOccurrenceStore())
        .list()
        .filter((item) => item.status === "planned" || item.status === "admitted");
      const recent = readAutomationAdmissionEvents({
        since: now - 24 * 60 * 60_000,
        until: now,
        limit: 1,
      });
      const view = {
        observedAt: now,
        agents: [capacity.read("claude", now), capacity.read("codex", now)],
        plannedOccurrences: occurrences.length,
        nextOccurrenceAt:
          occurrences.length === 0 ? null : Math.min(...occurrences.map((item) => item.notBefore)),
        latestDecision: recent.events.at(-1) ?? null,
      };
      return {
        exitCode: 0,
        stdout: rest.includes("--json")
          ? json(view)
          : [
              `agent capacity: ${view.agents.length} pools`,
              ...view.agents.map(
                (agent) =>
                  `- ${agent.agent}: ${agent.state} auth=${agent.authentication} active=${agent.activeAutonomousLeases} nextProbe=${new Date(agent.nextProbeAt).toISOString()}`,
              ),
              `planned occurrences: ${view.plannedOccurrences}`,
              `latest decision: ${view.latestDecision?.reason ?? "none"}`,
            ].join("\n"),
      };
    }
    if (args[0] === "history") {
      const parsed = parseHistoryArgs(args.slice(1), now);
      if (typeof parsed === "string") return { exitCode: 1, stderr: parsed };
      const history = readAutomationAdmissionEvents({
        since: parsed.since,
        until: now,
        limit: 200,
      });
      const view = { window: { since: parsed.since, until: now }, ...history };
      return {
        exitCode: 0,
        stdout: parsed.json
          ? json(view)
          : [
              `agent capacity history: ${history.events.length} event${history.events.length === 1 ? "" : "s"}${history.truncated ? " (truncated)" : ""}`,
              ...history.events.map(
                (event) =>
                  `- ${new Date(event.at).toISOString()} ${event.kind} ${event.source} ${event.reason}`,
              ),
            ].join("\n"),
      };
    }
    return {
      exitCode: 1,
      stderr: "Usage: automation capacity <status|history> [--since <time>] [--json]",
    };
  } catch (error) {
    return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
}
