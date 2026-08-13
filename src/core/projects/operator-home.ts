import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appStateDir } from "../../shared/state-dir.js";
import { createLogger } from "../../shared/utils/logger.js";
import { CODEX_SKIP_PERMS, SKIP_PERMS } from "../agents/resume-command.js";
import { markSessionStopped } from "../agents/runningSessions.js";
import { performStart } from "../command/dispatch.js";
import type { HandlerDeps } from "../deps.js";
import { mcpProfileSpec } from "../mcp/profiles.js";
import { operatorSessionName } from "./operator.js";
import { setPathForSession } from "./sessionPathMap.js";

const log = createLogger("projects.operator-home");

const MANAGED_POLICY_START = "<!-- TCB_MANAGED_OPERATOR_POLICY_START -->";
const MANAGED_POLICY_END = "<!-- TCB_MANAGED_OPERATOR_POLICY_END -->";
const MANAGED_OPERATOR_POLICY = `${MANAGED_POLICY_START}
## Managed tmux-claude-bot operator policy

You are the **operator** for tmux-claude-bot. The user talks to you in chat (Telegram/
Lark); you manage their coding projects/agents on their behalf using the \`tcb\` CLI and
the Home Operator skill and MCP profiles when available. You do NOT write code yourself -
you open projects, dispatch work, and report status.

This directory is the persistent working home for the Home Operator session. It
is not a product repository, target project, or WorkOrder worker directory.

## Recipes
- Start diagnostics with \`tcb.observer.status\` when the managed Observer/Home MCP
  profile is available. Fall back to \`tcb dashboard --json\`; do not read state files.
- Open / switch a project: \`tcb open <name>\` (or \`tcb projects\` to list).
- Dispatch a task to a project's agent: \`tcb send <name> "<task>"\` (waits for the reply).
  For long tasks use \`tcb send <name> "<task>" --no-wait\` then \`tcb peek <name>\` to report.
- Status drilldown: \`tcb dashboard\` (human view), \`tcb peek <name>\` (one pane).
- Delegate clarified current work: \`tcb autopilot <name> [requirement]\`.
- Fleet control: \`tcb control <name> <esc|enter|restart|…>\`, \`tcb open\`, and Autopilot.

## House rules
- **Restate and confirm before destructive actions** (removing a project, killing/
  restarting a session, any \`rm\`/destructive shell): say what you're about to do and
  wait for the user's "yes".
- Reply **concisely** — this is a chat surface.
- You drive OTHER sessions; never send to yourself.
- Do not edit files in target projects directly from this directory. Delegate
  code-changing work through the bot's project sessions, Autopilot, Loop
  Supervisor, or WorkOrder path.
- MCP observation grants no mutation authority. Home operations must name an
  explicit target and pass the control service's normal conflict and WorkOrder gates.
${MANAGED_POLICY_END}`;

const OPERATOR_INSTRUCTIONS = `# Home Operator

${MANAGED_OPERATOR_POLICY}
`;
const LEGACY_OPERATOR_INSTRUCTIONS = `# Home Operator

You are the **operator** for tmux-claude-bot. The user talks to you in chat (Telegram/
Lark); you manage their coding projects/agents on their behalf using the \`tcb\` CLI and
the Home Operator skill when available. You do NOT write code yourself -
you open projects, dispatch work, and report status.

This directory is the persistent working home for the Home Operator session. It
is not a product repository, target project, or WorkOrder worker directory.

## Recipes
- Open / switch a project: \`tcb open <name>\` (or \`tcb projects\` to list).
- Dispatch a task to a project's agent: \`tcb send <name> "<task>"\` (waits for the reply).
  For long tasks use \`tcb send <name> "<task>" --no-wait\` then \`tcb peek <name>\` to report.
- Status: \`tcb dashboard\` (all sessions), \`tcb peek <name>\` (one pane).
- Delegate clarified current work: \`tcb autopilot <name> [requirement]\`.
- Fleet control: \`tcb control <name> <esc|enter|restart|…>\`, \`tcb open\`, and Autopilot.

## House rules
- **Restate and confirm before destructive actions** (removing a project, killing/
  restarting a session, any \`rm\`/destructive shell): say what you're about to do and
  wait for the user's "yes".
- Reply **concisely** — this is a chat surface.
- You drive OTHER sessions; never send to yourself.
- Do not edit files in target projects directly from this directory. Delegate
  code-changing work through the bot's project sessions, Autopilot, Loop
  Supervisor, or WorkOrder path.
`;

const OPERATOR_README = `# Home Operator Workspace

This directory is managed by tmux-claude-bot for the Home Operator session.

It is intentionally separate from product repositories and Loop worker
worktrees. Use it for operator context, discovery, and controlled delegation
through the \`tcb\` CLI or role-scoped MCP tools.

Files:

- \`CLAUDE.md\`: Claude Code operator instructions.
- \`AGENTS.md\`: Codex/cross-agent operator instructions.
- \`role-manifest.json\`: machine-readable role, authority, and provenance metadata.
- \`skills/\`: role descriptors for Home Operator and Observer policy.
- \`mcp/\`: generated Observer and Home MCP profile descriptors.

Do not treat this directory as authority to mutate arbitrary projects. The bot
control service remains responsible for target resolution, conflict checks, and
WorkOrder boundaries.
`;

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content);
}

function writeManagedOperatorInstructions(path: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, OPERATOR_INSTRUCTIONS);
    return;
  }
  const existing = readFileSync(path, "utf8");
  if (existing === LEGACY_OPERATOR_INSTRUCTIONS) {
    writeFileSync(path, OPERATOR_INSTRUCTIONS);
    return;
  }
  const start = existing.indexOf(MANAGED_POLICY_START);
  const end = existing.indexOf(MANAGED_POLICY_END);
  if (start >= 0 && end >= start) {
    const next = `${existing.slice(0, start)}${MANAGED_OPERATOR_POLICY}${existing.slice(
      end + MANAGED_POLICY_END.length,
    )}`;
    if (next !== existing) writeFileSync(path, next);
    return;
  }
  const withoutIncompleteMarkers = existing
    .replaceAll(MANAGED_POLICY_START, "")
    .replaceAll(MANAGED_POLICY_END, "")
    .trimEnd();
  writeFileSync(path, `${withoutIncompleteMarkers}\n\n${MANAGED_OPERATOR_POLICY}\n`);
}

/** The operator's working directory: configured dir, else a `home` subdir of the state dir. */
export function operatorHomeDir(config: { homeOperator?: { dir: string } }): string {
  return config.homeOperator?.dir || join(appStateDir(), "home");
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isOperatorHomePath(
  config: { homeOperator?: { dir: string } },
  path: string | undefined,
): boolean {
  if (path === undefined || path.trim().length === 0) return false;
  return realpathOrSelf(path) === realpathOrSelf(operatorHomeDir(config));
}

/** Seed the home dir + operator instructions. Idempotent - never clobbers edits. */
export function provisionOperatorHome(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    "README.md": OPERATOR_README,
    "role-manifest.json": prettyJson({
      schemaVersion: 1,
      role: "home-operator",
      canonicalSkill: "tcb-home-operator",
      observerSkill: "tcb-observer",
      workspaceKind: "operator",
      authority: "operator-provenance-only",
      enforcement:
        "The control service must validate target identity, conflict state, role, and capability before mutation.",
      generatedBy: "tmux-claude-bot",
    }),
  };
  for (const [fileName, content] of Object.entries(files)) {
    writeIfMissing(join(dir, fileName), content);
  }
  writeManagedOperatorInstructions(join(dir, "CLAUDE.md"));
  writeManagedOperatorInstructions(join(dir, "AGENTS.md"));
  const skillsDir = join(dir, "skills");
  const mcpDir = join(dir, "mcp");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(mcpDir, { recursive: true });
  writeIfMissing(
    join(skillsDir, "tcb-home-operator.json"),
    prettyJson({
      schemaVersion: 1,
      name: "tcb-home-operator",
      role: "home-operator",
      capabilityClasses: ["read-only observation", "low-risk control", "delegation"],
      mutationBoundary:
        "Use explicit target identity and bot control-service checks; do not edit target project files directly from the operator workspace.",
    }),
  );
  writeIfMissing(
    join(skillsDir, "tcb-observer.json"),
    prettyJson({
      schemaVersion: 1,
      name: "tcb-observer",
      role: "observer",
      capabilityClasses: ["read-only observation"],
      mutationBoundary:
        "No mutation, prompt delivery, delegation, repair, or repository operations.",
    }),
  );
  writeIfMissing(join(mcpDir, "observer.json"), prettyJson(mcpProfileSpec("observer")));
  writeIfMissing(join(mcpDir, "home.json"), prettyJson(mcpProfileSpec("home")));
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
