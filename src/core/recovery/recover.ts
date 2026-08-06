import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentKind } from "../../shared/types.js";
import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { getAgentRuntimeRecord } from "../agents/agent-runtime-records.js";
import {
  findRolloutBySessionId,
  readCodexModelFromRollout,
} from "../agents/codex/codex-rollout.js";
import { allRunningSessions } from "../agents/runningSessions.js";
import type { HandlerDeps } from "../deps.js";
import { isReservedInfrastructureSession } from "../projects/operator.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import { clearRecoveryIntent, hasRecoveryIntent, recoveryIntentFor } from "./recovery-intent.js";

const log = createLogger("recovery.recover");

/** Stagger between agent launches so recovery doesn't spawn every claude/codex at
 * once (each is a heavy process + a TUI boot). */
const RECOVER_STAGGER_MS = 1500;
const DEFAULT_CODEX_ROOT = `${homedir()}/.codex`;

/**
 * What recovery will do with one rostered project. The roster is every session
 * with a recorded path ({@link allSessionPaths}); removal clears that record, so
 * a deleted project never appears here.
 *  - `launch`         tmux session gone (reboot) OR agent not running → (re)create
 *                     the session if needed and (re)launch the agent, resuming the
 *                     recorded conversation id when we have one.
 *  - `recreate-shell` session gone but no agent was ever started → restore just the
 *                     tmux session + cwd (a bare shell), nothing to launch.
 *  - `alive`          session present and the agent is already running → nothing.
 *  - `missing-dir`    session gone and its working dir no longer exists → cannot
 *                     recreate; skip.
 */
export type RecoverAction = "launch" | "recreate-shell" | "alive" | "missing-dir";

export interface RecoverItem {
  session: string;
  path: string;
  kind: AgentKind;
  /** Exact recorded launch command (flavor), or null if no agent was started. */
  command: string | null;
  /** Exact conversation id to resume, or null → resume the most recent (--continue). */
  sessionId: string | null;
  /** Task id that authorizes boot-only recovery, or null for roster/manual recovery. */
  recoveryTaskId: string | null;
  /** The tmux session is gone and must be recreated before launching. */
  needsRecreate: boolean;
  action: RecoverAction;
}

export interface RecoverResult {
  launched: RecoverItem[];
  shellOnly: RecoverItem[];
  alreadyAlive: RecoverItem[];
  skippedMissingDir: RecoverItem[];
  failed: Array<{ item: RecoverItem; error: string }>;
  /** True when this call was refused because another recovery was already running
   * in this process (the guard below) — nothing was actioned. */
  busy?: boolean;
}

/** In-process guard: a single recovery pass at a time. A second concurrent
 * execute would race the first over the same sessions and could double-launch one
 * caught mid-boot (created pane, agent process not yet visible to checkIfRunning).
 * Scope is this process only — fine for the bot, where every surface funnels here;
 * a separate `tcb recover` process is not covered (use one or the other). */
let recovering = false;

/**
 * Classify every rostered project WITHOUT side effects — the dry-run plan behind
 * the `/recover` preview. Source of truth is live tmux (is the session present,
 * is the agent running) plus on-disk records (path/kind/command/id), exactly the
 * resolve-from-live-then-fall-back-to-recorded pattern the rest of the bot uses.
 */
export async function planRecovery(
  deps: HandlerDeps,
  opts: { autoOnly?: boolean } = {},
): Promise<RecoverItem[]> {
  // Roster = the sessions the bot last knew to be RUNNING (not every recorded
  // project), so recovery restores the pre-reboot running state rather than
  // blindly relaunching everything. A running session with no recorded path
  // can't be recreated, so drop it. Reserved infrastructure sessions are
  // excluded: their lifecycle is owned by their boot provisioners, not generic
  // recovery.
  const prefix = deps.config.projectSessionPrefix;
  const runningRoster = allRunningSessions().filter(
    (session) => !isReservedInfrastructureSession(session, prefix),
  );
  const idleRosterCount = opts.autoOnly
    ? runningRoster.filter((session) => !hasRecoveryIntent(session)).length
    : 0;
  if (opts.autoOnly && idleRosterCount > 0) {
    log.info("auto-recover skipped idle roster entries", {
      data: { skippedIdle: idleRosterCount },
    });
  }
  const roster = runningRoster
    .filter((session) => !opts.autoOnly || hasRecoveryIntent(session))
    .map((session) => ({ session, path: getPathBySession(session) }))
    .filter((r): r is { session: string; path: string } => r.path !== null);
  // Each session's classification is independent and each does its own tmux /
  // process shell-out (isPaneAlive, checkIfRunning), so resolve them concurrently
  // — sequential would be 2N serial subprocess calls before the preview renders.
  return Promise.all(roster.map(({ session, path }) => classifySession(deps, session, path)));
}

/** Classify one rostered project into a RecoverItem (no side effects). */
async function classifySession(
  deps: HandlerDeps,
  session: string,
  path: string,
): Promise<RecoverItem> {
  const record = getAgentRuntimeRecord(session);
  const base = {
    session,
    path,
    kind: record.kind,
    command: record.startCommand,
    sessionId: record.liveSessionId,
    recoveryTaskId: recoveryIntentFor(session)?.taskId ?? null,
  };
  if (await deps.bridge.isPaneAlive(session)) {
    // Session is present. If its agent is already running there's nothing to do;
    // if not (crashed/exited) and we know how to start it, relaunch in place.
    const running = await deps.agent.checkIfRunning(session);
    return running || record.startCommand === null
      ? { ...base, needsRecreate: false, action: "alive" }
      : { ...base, needsRecreate: false, action: "launch" };
  }
  if (!existsSync(path)) {
    return { ...base, needsRecreate: true, action: "missing-dir" };
  }
  return {
    ...base,
    needsRecreate: true,
    action: record.startCommand === null ? "recreate-shell" : "launch",
  };
}

/**
 * Restore projects after a reboot (or on demand): recreate each gone tmux session
 * in its recorded dir and (re)launch its agent, resuming the recorded conversation
 * id when available. Idempotent — a session that's already alive with its agent
 * running is left untouched (and the runners' own check-if-running is a second
 * guard). `dryRun` returns the plan without touching anything (for the preview).
 */
export async function recoverProjects(
  deps: HandlerDeps,
  opts: { dryRun?: boolean; staggerMs?: number; autoOnly?: boolean } = {},
): Promise<RecoverResult> {
  const staggerMs = opts.staggerMs ?? RECOVER_STAGGER_MS;
  // Refuse a second concurrent execute before doing any work (a dry-run preview is
  // read-only, so it's never blocked).
  if (!opts.dryRun && recovering) {
    return {
      launched: [],
      shellOnly: [],
      alreadyAlive: [],
      skippedMissingDir: [],
      failed: [],
      busy: true,
    };
  }
  const plan = await planRecovery(deps, {
    ...(opts.autoOnly !== undefined ? { autoOnly: opts.autoOnly } : {}),
  });
  // Bucket the plan by action once, then reuse the buckets everywhere below
  // (preview, result skeleton, and the execute list) instead of re-filtering.
  const launch = plan.filter((i) => i.action === "launch");
  const recreateShell = plan.filter((i) => i.action === "recreate-shell");
  const alreadyAlive = plan.filter((i) => i.action === "alive");
  const skippedMissingDir = plan.filter((i) => i.action === "missing-dir");

  if (opts.dryRun) {
    return {
      launched: launch,
      shellOnly: recreateShell,
      alreadyAlive,
      skippedMissingDir,
      failed: [],
    };
  }

  const result: RecoverResult = {
    launched: [],
    shellOnly: [],
    alreadyAlive,
    skippedMissingDir,
    failed: [],
  };
  recovering = true;
  try {
    return await runRecovery(deps, [...launch, ...recreateShell], result, staggerMs);
  } finally {
    recovering = false;
  }
}

/** The execute loop over the already-bucketed actionable items, extracted so the
 * in-flight guard's try/finally stays thin. */
async function runRecovery(
  deps: HandlerDeps,
  actionable: RecoverItem[],
  result: RecoverResult,
  staggerMs: number,
): Promise<RecoverResult> {
  for (let i = 0; i < actionable.length; i++) {
    const item = actionable[i] as RecoverItem;
    try {
      if (item.needsRecreate) {
        await deps.bridge.createSession(item.session, item.path);
      }
      if (item.action === "recreate-shell") {
        result.shellOnly.push(item);
        log.info("recovered session (shell only)", { session: item.session });
        continue;
      }
      // command is non-null for a "launch" item (see planRecovery).
      const command = await recoveryStartCommand(item);
      if (item.sessionId) {
        await deps.agent.startWithResume(item.session, item.sessionId, command);
      } else {
        await deps.agent.start(item.session, command);
      }
      if (item.recoveryTaskId) {
        clearRecoveryIntent(item.session, item.recoveryTaskId);
      }
      deps.configResolver.invalidate(item.session);
      result.launched.push(item);
      log.info("recovered project", {
        session: item.session,
        data: {
          kind: item.kind,
          resume: item.sessionId ? "exact-id" : "continue",
          ...(item.recoveryTaskId
            ? { reason: "unfinished-task", taskId: item.recoveryTaskId }
            : {}),
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ item, error });
      log.error("recovery failed for session", { session: item.session, err });
    }
    if (i < actionable.length - 1) await sleep(staggerMs);
  }
  return result;
}

export async function recoveryStartCommand(
  item: Pick<RecoverItem, "kind" | "command" | "sessionId">,
): Promise<string> {
  const command = item.command as string;
  if (item.kind !== "codex" || !item.sessionId) {
    return command;
  }
  const configRoot = codexHomeFromCommand(command) ?? DEFAULT_CODEX_ROOT;
  const rollout = await findRolloutBySessionId(configRoot, item.sessionId);
  if (!rollout?.path) return command;
  const model = await readCodexModelFromRollout(rollout.path);
  return model ? setCodexModel(command, model) : command;
}

function codexHomeFromCommand(command: string): string | null {
  const match = command.match(/(?:^|\s)CODEX_HOME=(?:"([^"]*)"|'([^']*)'|(\S+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

const CODEX_MODEL_ARG_RE =
  /(?:^|\s)(?:-m|--model)(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+))|(?:^|\s)(?:-c|--config)\s+model=(?:"[^"]*"|'[^']*'|\S+)/g;

function setCodexModel(command: string, model: string): string {
  const stripped = command.replace(CODEX_MODEL_ARG_RE, " ").replace(/\s+/g, " ").trim();
  return `${stripped} --model ${shellToken(model)}`;
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run reboot recovery automatically on boot (config `AUTO_RECOVER`). Idempotent —
 * when tmux survived a plain bot restart everything is already alive and this is a
 * no-op; it only does real work after a machine reboot. Best-effort: logs the
 * outcome and never throws into the boot path.
 */
export async function autoRecoverOnBoot(deps: HandlerDeps): Promise<void> {
  try {
    const res = await recoverProjects(deps, { autoOnly: true });
    if (res.busy) return;
    if (res.launched.length === 0 && res.shellOnly.length === 0) {
      log.info("auto-recover: nothing to restore", {
        data: { alreadyAlive: res.alreadyAlive.length },
      });
      return;
    }
    log.info("auto-recover complete", {
      data: {
        launched: res.launched.length,
        shellOnly: res.shellOnly.length,
        alreadyAlive: res.alreadyAlive.length,
        failed: res.failed.length,
      },
    });
  } catch (err) {
    log.error("auto-recover failed", { err });
  }
}
