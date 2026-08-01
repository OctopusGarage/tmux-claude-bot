import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import { CODEX_SKIP_PERMS, SKIP_PERMS } from "../agents/resume-command.js";
import { markSessionStopped } from "../agents/runningSessions.js";
import { performStart } from "../command/dispatch.js";
import type { HandlerDeps } from "../deps.js";
import { operatorSessionName } from "./operator.js";
import { setPathForSession } from "./sessionPathMap.js";

const log = createLogger("projects.operator-home");

const OPERATOR_CLAUDE_MD = `# Home Operator

You are the **operator** for tmux-claude-bot. The user talks to you in chat (Telegram/
Lark); you manage their coding projects/agents on their behalf using the \`tcb\` CLI and
the **tmux-claude-bot** skill (already installed). You do NOT write code yourself —
you open projects, dispatch work, and report status.

## Recipes
- Open / switch a project: \`tcb open <name>\` (or \`tcb projects\` to list).
- Dispatch a task to a project's agent: \`tcb send <name> "<task>"\` (waits for the reply).
  For long tasks use \`tcb send <name> "<task>" --no-wait\` then \`tcb peek <name>\` to report.
- Status: \`tcb dashboard\` (all sessions), \`tcb peek <name>\` (one pane).
- Delegate clarified current work: \`tcb autopilot <name> [requirement]\`.
- Fleet control: \`tcb control <name> <esc|enter|restart|…>\`, \`tcb open\`, autopilot/batch.

## House rules
- **Restate and confirm before destructive actions** (removing a project, killing/
  restarting a session, any \`rm\`/destructive shell): say what you're about to do and
  wait for the user's "yes".
- Reply **concisely** — this is a chat surface.
- You drive OTHER sessions; never send to yourself.
`;

/** The operator's working directory: configured dir, else a `home` subdir of the state dir. */
export function operatorHomeDir(config: Pick<HandlerDeps["config"], "homeOperator">): string {
  return config.homeOperator.dir || join(appStateDir(), "home");
}

/** Seed the home dir + operator CLAUDE.md. Idempotent — never clobbers an existing CLAUDE.md. */
export function provisionOperatorHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const md = join(dir, "CLAUDE.md");
  if (!existsSync(md)) writeFileSync(md, OPERATOR_CLAUDE_MD);
}

/**
 * Resolve the start command for the operator's configured agent kind.
 * Finds the first startCommands entry matching the agent kind; falls back to
 * claudeStartCommand. Ensures --dangerously-skip-permissions is present, since
 * the operator runs unattended (no one can answer per-command prompts in chat).
 */
function resolveOperatorStartCommand(config: HandlerDeps["config"]): string {
  const agentKind = config.homeOperator.agent;
  const match = config.startCommands.find((c) => c.agent === agentKind);
  if (agentKind === "codex" && !match) {
    log.warn("operator agent=codex but no codex start command configured; falling back to claude", {
      data: { hint: "set CODEX_START_COMMAND to run the operator as codex" },
    });
  }
  const base = match?.command ?? config.claudeStartCommand;
  // Use the skip-perms flag matching the RESOLVED command's agent: codex uses
  // `--yolo`, claude uses `--dangerously-skip-permissions`. (A codex request with no
  // codex command falls back to the claude command above, so it's claude here too.)
  const effectiveAgent = match?.agent ?? "claude";
  const skipFlag = effectiveAgent === "codex" ? CODEX_SKIP_PERMS : SKIP_PERMS;
  return base.includes(skipFlag) ? base : `${base} ${skipFlag}`;
}

/** Boot step: ensure the operator session exists + its agent is running. No-op when disabled. */
export async function startOperator(deps: HandlerDeps): Promise<void> {
  if (!deps.config.homeOperator.enabled) return;
  const name = operatorSessionName(deps.config.projectSessionPrefix);
  const dir = operatorHomeDir(deps.config);
  try {
    provisionOperatorHome(dir);
    const alive = await deps.bridge.isPaneAlive(name);
    if (!alive) {
      await deps.bridge.createSession(name, dir);
    }
    // Record path so tcb peek/labels/getPathBySession work for the operator session.
    setPathForSession(name, dir);
    const command = resolveOperatorStartCommand(deps.config);
    // performStart is idempotent ("already-running"); it injects skip-permissions per command.
    const res = await performStart(deps, name, command);
    // Remove from the reboot-recovery roster: the operator's lifecycle is
    // boot-only (not recovery), so a roster entry would cause spurious recovery.
    markSessionStopped(name);
    log.info("operator session ensured", { data: { session: name, dir, start: res } });
  } catch (err) {
    log.error("failed to start operator session", { err });
  }
}
