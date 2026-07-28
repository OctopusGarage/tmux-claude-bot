import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import { CODEX_SKIP_PERMS, SKIP_PERMS } from "../agents/resume-command.js";
import { markSessionStopped } from "../agents/runningSessions.js";
import { performStart as defaultPerformStart } from "../command/dispatch.js";
import type { HandlerDeps } from "../deps.js";
import {
  isLoopSupervisorSessionName,
  loopSupervisorSessionName,
  loopSupervisorSessionNames,
} from "../projects/operator.js";
import { setPathForSession } from "../projects/sessionPathMap.js";

export { loopSupervisorSessionName, loopSupervisorSessionNames } from "../projects/operator.js";

const log = createLogger("loop.supervisor-session");

const LOOP_SUPERVISOR_INSTRUCTIONS = `# Loop Supervisor

You are the Loop Supervisor for tmux-claude-bot.

This directory is the persistent working home for a reserved loop supervisor
session. It is not a product repository. Its job is to receive scheduled Loop
Engineering work orders from tmux-claude-bot, supervise delivery through the
existing project agent sessions, and return a machine-readable completion
summary.

## Responsibilities

- Read the full WorkOrder in the incoming prompt before taking action.
- Use the \`tcb\` CLI to inspect, open, send work to, peek, and control the target
  project sessions. Drive other sessions; do not send delegated work to yourself.
- Diagnose failures before giving up. If a project agent is not ready, try the
  appropriate recovery path once before marking the WorkOrder blocked.
- Keep changes small, bounded, verified, and aligned with the WorkOrder's
  allowedActions, blockedActions, commit policy, and skill list.
- Prefer the target project's own instructions, tests, and setup scripts. Read
  its AGENTS.md / CLAUDE.md / README before directing implementation work.
- Finish every WorkOrder with the required final marker and strict JSON summary.

## Boundaries

- Do not call model-provider APIs directly or add model SDK/API-key based helper
  scripts. AI work must go through the currently running Claude Code / Codex
  sessions managed by this bot.
- Do not edit this supervisor directory as if it were the target project.
- Do not perform broad rewrites, dependency upgrades, destructive git operations,
  secret changes, or deployment changes unless the WorkOrder explicitly allows
  them and verification proves the result.
- Do not silently ignore partial work. If delegated work leaves a dirty worktree,
  either recover it, commit it according to policy after verification, or report a
  clear blocker.

## Operating Loop

1. Parse the WorkOrder, target project, required final marker, and expected JSON
   fields.
2. Inspect target state with \`tcb dashboard\`, \`tcb peek <project>\`, and project
   git/test commands as needed.
3. Delegate focused work to the target project session with \`tcb send <project>
   "<task>"\`; monitor progress and recover readiness/verification failures.
4. Verify using the WorkOrder's commands and the target project's local rules.
5. Ensure the target worktree is clean or explicitly explain why it is not.
6. Emit the required final marker followed by strict JSON with status,
   actionsTaken, delegatedTasks, finalVerification, commits, and followUps.
`;

export function isLoopSupervisorSession(session: string, prefix: string): boolean {
  return isLoopSupervisorSessionName(session, prefix);
}

export function loopSupervisorDir(
  config: {
    loopEngineering: {
      supervisor: { dir: string; poolSize?: number } & Record<string, unknown>;
    } & Record<string, unknown>;
    projectSessionPrefix?: string;
  },
  sessionName?: string,
): string {
  const configuredDir = config.loopEngineering.supervisor.dir;
  const prefix = config.projectSessionPrefix ?? "tmux_proj_";
  const sessions = loopSupervisorSessionNames(
    prefix,
    config.loopEngineering.supervisor.poolSize ?? 1,
  );
  const effectiveSession = sessionName ?? sessions[0] ?? loopSupervisorSessionName(prefix);
  if (sessions.length <= 1) return configuredDir || join(appStateDir(), "loop-supervisor");
  const slotDirName = basename(effectiveSession).replace(/^.*loop-supervisor/, "loop-supervisor");
  return join(configuredDir || appStateDir(), slotDirName);
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
  sessionName?: string,
): Promise<boolean> {
  if (!deps.config.loopEngineering.supervisor.enabled) return false;
  const name =
    sessionName ??
    loopSupervisorSessionNames(
      deps.config.projectSessionPrefix,
      deps.config.loopEngineering.supervisor.poolSize,
    )[0] ??
    loopSupervisorSessionName(deps.config.projectSessionPrefix);
  const dir = loopSupervisorDir(deps.config, name);
  try {
    provisionLoopSupervisorHome(dir);
    if (!(await deps.bridge.isPaneAlive(name))) {
      await deps.bridge.createSession(name, dir);
    }
    setPathForSession(name, dir);
    const start = await performStart(deps, name, resolveSupervisorStartCommand(deps.config));
    markSessionStopped(name);
    const alive = await deps.bridge.isPaneAlive(name);
    log.info("loop supervisor session ensured", { data: { session: name, dir, start, alive } });
    return alive;
  } catch (err) {
    log.error("failed to start loop supervisor session", { err });
    return false;
  }
}

export async function startLoopSupervisors(
  deps: HandlerDeps,
  performStart: typeof defaultPerformStart = defaultPerformStart,
): Promise<boolean> {
  if (!deps.config.loopEngineering.supervisor.enabled) return false;
  const sessions = loopSupervisorSessionNames(
    deps.config.projectSessionPrefix,
    deps.config.loopEngineering.supervisor.poolSize,
  );
  const results = await Promise.all(
    sessions.map((session) => startLoopSupervisor(deps, performStart, session)),
  );
  return results.every(Boolean);
}
