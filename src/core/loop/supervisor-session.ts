import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import { CODEX_SKIP_PERMS, SKIP_PERMS } from "../agents/resume-command.js";
import { markSessionStopped } from "../agents/runningSessions.js";
import { performStart as defaultPerformStart } from "../command/dispatch.js";
import type { HandlerDeps } from "../deps.js";
import { loopSupervisorSessionName } from "../projects/operator.js";
import { setPathForSession } from "../projects/sessionPathMap.js";

export { loopSupervisorSessionName } from "../projects/operator.js";

const log = createLogger("loop.supervisor-session");

const LOOP_SUPERVISOR_INSTRUCTIONS = `# Loop Supervisor

You are the Loop Supervisor for tmux-claude-bot.

You process scheduled Loop Engineering work orders. You manage other project
sessions through the tcb CLI. Do not call model-provider APIs directly. You
do not send work to yourself. You diagnose failures before giving up, keep
changes small, and finish every work order with the required final marker and
JSON summary.
`;

export function isLoopSupervisorSession(session: string, prefix: string): boolean {
  return session === loopSupervisorSessionName(prefix);
}

export function loopSupervisorDir(config: Pick<HandlerDeps["config"], "loopEngineering">): string {
  return config.loopEngineering.supervisor.dir || join(appStateDir(), "loop-supervisor");
}

export function provisionLoopSupervisorHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    const file = join(dir, fileName);
    if (!existsSync(file)) writeFileSync(file, LOOP_SUPERVISOR_INSTRUCTIONS);
  }
}

function resolveSupervisorStartCommand(config: HandlerDeps["config"]): string {
  const agentKind = config.loopEngineering.supervisor.agent;
  const match = config.startCommands.find((command) => command.agent === agentKind);
  if (agentKind === "codex" && !match) {
    log.warn(
      "loop supervisor agent=codex but no codex start command configured; falling back to claude",
      {
        data: { hint: "set CODEX_START_COMMAND to run the loop supervisor as codex" },
      },
    );
  }
  const base = match?.command ?? config.claudeStartCommand;
  const effectiveAgent = match?.agent ?? "claude";
  const skipFlag = effectiveAgent === "codex" ? CODEX_SKIP_PERMS : SKIP_PERMS;
  return base.includes(skipFlag) ? base : `${base} ${skipFlag}`;
}

export async function startLoopSupervisor(
  deps: HandlerDeps,
  performStart: typeof defaultPerformStart = defaultPerformStart,
): Promise<void> {
  if (!deps.config.loopEngineering.supervisor.enabled) return;
  const name = loopSupervisorSessionName(deps.config.projectSessionPrefix);
  const dir = loopSupervisorDir(deps.config);
  try {
    provisionLoopSupervisorHome(dir);
    if (!(await deps.bridge.isPaneAlive(name))) {
      await deps.bridge.createSession(name, dir);
    }
    setPathForSession(name, dir);
    const start = await performStart(deps, name, resolveSupervisorStartCommand(deps.config));
    markSessionStopped(name);
    log.info("loop supervisor session ensured", { data: { session: name, dir, start } });
  } catch (err) {
    log.error("failed to start loop supervisor session", { err });
  }
}
