import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { claudeBinFromStartCommand, claudeStartCommandWithSessionId } from "../../shared/config.js";
import { SHELL_RC_FILES } from "../../shared/shell-rc.js";
import type { AgentKind } from "../../shared/types.js";
import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import { sleep } from "../../shared/utils/sleep.js";
import { getAgentRuntimeRecord, recordAgentLaunch } from "../agents/agent-runtime-records.js";
import { buildAgentStatusReport, readAgentLatestReply } from "../agents/read.js";
import { CODEX_SKIP_PERMS, SKIP_PERMS } from "../agents/resume-command.js";
import { findProjectAutomationConflictForSession } from "../automation/project-conflicts.js";
import type { HandlerDeps } from "../deps.js";
import { messages } from "../i18n/index.js";
import { getPathBySession, resolveLiveSessionName } from "../projects/sessionPathMap.js";
import { recoveryStartCommand } from "../recovery/recover.js";
import { getActionPrecondition, isMessageAction } from "./actions.js";
import { sendContextReset } from "./context-reset.js";
import type { QueuedMessage } from "./queue.js";

const log = createLogger("command.dispatch");

/** Derive the AgentKind for a start command by matching against startCommands config. */
function agentKindForCommand(deps: HandlerDeps, command: string | undefined): AgentKind {
  if (command === undefined) return "claude";
  const normalized = command
    .replace(new RegExp(`\\s+${SKIP_PERMS.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}$`), "")
    .replace(new RegExp(`\\s+${CODEX_SKIP_PERMS.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}$`), "");
  return (
    deps.config.startCommands.find((c) => c.command === command || c.command === normalized)
      ?.agent ?? "claude"
  );
}

/**
 * True when `bin` is defined as a shell alias or function in one of the user's
 * shell rc files. The launch is typed into the session's interactive shell via
 * tmux `send-keys`, which sources these files — so such a name resolves at run
 * time even though it is not an executable on PATH. Mirroring that here keeps the
 * pre-flight from rejecting a perfectly launchable alias/function.
 */
function definedInShellRc(bin: string): boolean {
  const esc = bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `alias name=…`  |  `name()` / `name ()` / `function name()`  |  `function name …`
  const re = new RegExp(
    `^\\s*(alias\\s+${esc}=|(function\\s+)?${esc}\\s*\\(\\s*\\)|function\\s+${esc}\\s)`,
    "m",
  );
  const home = process.env.HOME ?? homedir();
  for (const file of SHELL_RC_FILES) {
    try {
      if (re.test(readFileSync(nodePath.join(home, file), "utf8"))) return true;
    } catch {
      // rc file may not exist — skip it
    }
  }
  return false;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const INTERACTIVE_SHELL_LOOKUP_TIMEOUT_MS = 8000;
const interactiveShellVisibilityCache = new Map<string, boolean>();

function interactiveShellVisibilityCacheKey(bin: string): string {
  return JSON.stringify([
    bin,
    process.env.SHELL ?? "",
    process.env.HOME ?? "",
    process.env.PATH ?? "",
  ]);
}

function visibleToInteractiveShell(bin: string): boolean {
  const cacheKey = interactiveShellVisibilityCacheKey(bin);
  const cached = interactiveShellVisibilityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const shells = process.env.SHELL ? [process.env.SHELL] : ["/bin/zsh", "/bin/bash"];
  for (const shell of shells) {
    try {
      execFileSync(shell as string, ["-lic", `command -v -- ${shellQuote(bin)} >/dev/null 2>&1`], {
        stdio: "ignore",
        timeout: INTERACTIVE_SHELL_LOOKUP_TIMEOUT_MS,
        env: process.env,
      });
      interactiveShellVisibilityCache.set(cacheKey, true);
      return true;
    } catch {
      // Shell missing, rc error, or command unavailable there — try the next shell.
    }
  }
  interactiveShellVisibilityCache.set(cacheKey, false);
  return false;
}

export function assertClaudeBinaryAccessible(claudeStartCommand: string): void {
  const bin = claudeBinFromStartCommand(claudeStartCommand);
  if (nodePath.isAbsolute(bin)) {
    try {
      accessSync(bin, constants.X_OK);
      return;
    } catch {
      throw new Error(`Agent binary not found or not executable: ${bin}`);
    }
  }
  const pathEnv = process.env.PATH;
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(nodePath.join(dir, bin), constants.X_OK);
      return;
    } catch {
      // continue searching
    }
  }
  // Not an executable on the bot process PATH — but the command runs in the
  // target session pane's interactive shell. Accept launchers that are either
  // explicit aliases/functions or binaries made visible by shell startup files
  // (common with nvm-installed `codex`).
  if (definedInShellRc(bin)) return;
  if (pathEnv !== undefined && visibleToInteractiveShell(bin)) return;
  throw new Error(`Agent binary "${bin}" not found in PATH`);
}

/**
 * Start Claude in `session`, optionally with a specific start command (from the
 * multi-command picker). Shared by the default `start` action and the adapters'
 * pick-a-start handlers so the assert/start/invalidate sequence stays in one place.
 */
export async function performStart(
  deps: HandlerDeps,
  session: string,
  command?: string,
): Promise<"started" | "already-running"> {
  // Authoritative guard for every start path (incl. the flavor-picker pick, which
  // bypasses the queue's precondition gate): never spawn a second agent.
  if (await deps.agent.checkIfRunning(session)) return "already-running";
  const baseCommand = command ?? deps.config.claudeStartCommand;
  assertClaudeBinaryAccessible(baseCommand);
  const kind = agentKindForCommand(deps, command);
  // Claude lets us pin the conversation id at launch (`--session-id`), so the bot
  // OWNS the exact id deterministically — no fragile lsof capture, and
  // independent sessions sharing a cwd stay unambiguous on resume. Codex can't pre-assign;
  // its id is read from the live rollout after start (resolveLiveTranscript).
  let launchCommand = baseCommand;
  let liveSessionId: string | null;
  if (kind === "claude") {
    liveSessionId = randomUUID();
    launchCommand = claudeStartCommandWithSessionId(baseCommand, liveSessionId);
  } else {
    liveSessionId = null;
  }
  recordAgentLaunch(session, {
    kind,
    startCommand: baseCommand,
    liveSessionId,
  });
  await deps.agent.start(session, launchCommand);
  deps.configResolver.invalidate(session); // new process → re-detect config dir
  return "started";
}

export async function performResume(
  deps: HandlerDeps,
  session: string,
): Promise<"resumed" | "already-running" | "missing-state"> {
  if (await deps.agent.checkIfRunning(session)) return "already-running";
  const record = getAgentRuntimeRecord(session);
  if (!record.startCommand || !record.liveSessionId) return "missing-state";
  assertClaudeBinaryAccessible(record.startCommand);
  recordAgentLaunch(session, {
    kind: record.kind,
    startCommand: record.startCommand,
    liveSessionId: record.liveSessionId,
  });
  const command = await recoveryStartCommand({
    kind: record.kind,
    command: record.startCommand,
    sessionId: record.liveSessionId,
  });
  await deps.agent.startWithResume(session, record.liveSessionId, command);
  deps.configResolver.invalidate(session);
  return "resumed";
}

/**
 * What a `/start` or `/restart` request should do for `session`. Surfaces the
 * "already running" precondition for start BEFORE the flavor picker, so a running
 * agent gets a clear "already running" instead of a pointless pick list.
 */
export async function startDisposition(
  deps: HandlerDeps,
  session: string,
  mode: "start" | "restart",
): Promise<"already-running" | "pick" | "go"> {
  if (mode === "start" && (await deps.agent.checkIfRunning(session))) return "already-running";
  return deps.config.startCommands.length > 1 ? "pick" : "go";
}

/** Restart Claude into `command`'s flavor (default: the primary), resuming the
 * conversation (`--continue`). Used by the restart-command picker. */
export async function performRestart(
  deps: HandlerDeps,
  session: string,
  command?: string,
): Promise<void> {
  const baseCommand = command ?? deps.config.claudeStartCommand;
  assertClaudeBinaryAccessible(baseCommand);
  recordAgentLaunch(session, {
    kind: agentKindForCommand(deps, command),
    startCommand: baseCommand,
  }); // keep the recorded flavor in sync
  await deps.agent.gracefulRestartWithContinue(session, command);
  deps.configResolver.invalidate(session); // new process → re-detect config dir
}

/**
 * The protocol-agnostic command layer. Given a queued message (an action + the
 * session it targets) and the core service bundle, perform the work against
 * tmux/Claude and return the plain-text result. Knows nothing about Telegram,
 * grammy, chats, or rendering — adapters wrap this and present the string.
 */

export async function executeMessage(msg: QueuedMessage, deps: HandlerDeps): Promise<string> {
  const m = messages(chatChannelOrDefault(msg.channel));
  let session = msg.sessionName;
  if (!session) return m.doneShort;
  if (!isMessageAction(msg.action)) {
    throw new Error(`Unknown action: ${msg.action}`);
  }
  const text = queuedMessageText(msg);

  log.info(`action=${msg.action} session=${session} text_len=${text.length}`);

  const liveSession = await resolveLiveSessionName(deps.bridge, session);
  if (!liveSession) {
    log.warn(`${msg.action} rejected: tmux session not found session=${session}`);
    return m.agentNotRunningRestart;
  }
  if (liveSession !== session) {
    log.warn(`${msg.action} remapped legacy session=${session} liveSession=${liveSession}`);
    session = liveSession;
  }

  // Single precondition gate for every mutating action (see getActionPrecondition):
  // never type into a wrong-state pane, never spawn a second agent.
  const precond = getActionPrecondition(msg.action);
  if (precond !== null) {
    const running = await deps.agent.checkIfRunning(session);
    if (precond === "running" && !running) {
      log.warn(`${msg.action} rejected: agent not running session=${session}`);
      return m.agentNotRunningRestart;
    }
    if (precond === "absent" && running) {
      log.info(`start rejected: agent already running session=${session}`);
      return m.agentAlreadyRunning;
    }
  }

  switch (msg.action) {
    case "text": {
      if (msg.origin !== "system") {
        const conflict = findProjectAutomationConflictForSession(session);
        if (conflict !== null) {
          log.warn("text rejected: project automation conflict", {
            data: {
              session,
              projectPath: conflict.projectPath,
              projectId: conflict.projectId,
              runId: conflict.runId,
              taskKind: conflict.taskKind,
              status: conflict.status,
              supervisorSession: conflict.supervisorSession,
            },
          });
          return m.projectAutomationBusy(
            conflict.taskKind,
            conflict.projectId,
            conflict.runId,
            conflict.supervisorSession,
          );
        }
      }
      try {
        await waitUntilInputReadyForMessage(msg, deps, session);
      } catch (err) {
        if (msg.origin === "system") throw err;
        log.warn("text rejected: agent input surface not ready", {
          err,
          data: { session, action: msg.action, channel: msg.channel },
        });
        return m.agentInputNotReady;
      }
      const promptText = text;
      log.info(`sending keys session=${session}`);
      await deps.bridge.sendKeys(promptText, session);
      log.info(`keys sent, waiting for done session=${session}`);

      // Wait in maxWaitDoneMs rounds up to maxWaitDoneTotalMs total. The first
      // expired round sends a one-time "still running" notice (when the adapter
      // provided a notify channel) and waiting continues — so long tasks resolve
      // with their real result instead of a partial snapshot, and nothing gets
      // typed into a still-busy pane. Past the horizon, give up with partials.
      let rawResult: string | undefined;
      try {
        let round = await deps.agent.waitUntilDone(session);
        let waitedMs = deps.config.maxWaitDoneMs;
        const maxWaitDoneTotalMs = msg.maxWaitDoneTotalMs ?? deps.config.maxWaitDoneTotalMs;
        let noticed = false;
        if (msg.doneProbe?.(round.output)) {
          rawResult = round.output;
        }
        while (rawResult === undefined && !round.done && waitedMs < maxWaitDoneTotalMs) {
          if (!noticed) {
            msg.notify?.(m.taskStillRunningNotice);
            noticed = true;
          }
          log.info(`still running session=${session} waited=${waitedMs}ms, continuing to wait`);
          round = await deps.agent.waitUntilDone(session);
          waitedMs += deps.config.maxWaitDoneMs;
          if (msg.doneProbe?.(round.output)) {
            rawResult = round.output;
          }
        }
        if (rawResult === undefined && !round.done) {
          log.warn(`gave up waiting session=${session} after ${waitedMs}ms`);
          return m.taskStillRunning(deps.output.process(round.output));
        }
        rawResult ??= round.output;
      } catch (err) {
        log.error(`waitUntilDone failed: ${err instanceof Error ? err.message : err}`);
        try {
          const pane = await deps.bridge.capturePane(session);
          rawResult = deps.output.process(pane);
        } catch (paneErr) {
          log.error(
            `capturePane fallback failed: ${paneErr instanceof Error ? paneErr.message : paneErr}`,
          );
          throw normalizeError(err);
        }
      }

      const projectPath = getPathBySession(session) ?? session;
      // Read the reply from the agent's transcript (cleaner than scraping the
      // ANSI pane). claude: <CLAUDE_CONFIG_DIR>/projects JSONL; codex: the rollout
      // under <CODEX_HOME>/sessions. Either may return null → pane fallback below.
      log.info(`looking up history session=${session} path=${projectPath}`);
      const historyReply = await readAgentLatestReply(
        deps.configResolver,
        session,
        projectPath,
        promptText,
      );
      if (historyReply?.trim()) {
        log.info(`history reply found len=${historyReply.length}`);
        const maxLen = deps.config.maxMessageLength - 100;
        if (historyReply.length > maxLen) {
          return `${historyReply.slice(0, maxLen)}\n\n${m.contentTruncated}`;
        }
        return historyReply;
      }

      if (msg.origin !== "system") {
        log.warn(`no history reply; suppressing pane output session=${session}`, {
          data: { rawLen: rawResult.length, channel: msg.channel },
        });
        return m.agentReplyUnavailable;
      }
      log.info(
        `no history reply, using pane output session=${session} raw_len=${rawResult.length}`,
      );
      const processed = deps.output.process(rawResult);
      log.info(`processed output len=${processed.length}`);
      if (!processed.trim()) {
        return m.agentEmptyOutput;
      }
      return processed;
    }
    case "start": {
      log.info(`starting agent session=${session}`);
      const r = await performStart(deps, session);
      return r === "already-running" ? m.agentAlreadyRunning : m.agentStarted;
    }
    case "resume": {
      log.info(`resuming agent session=${session}`);
      const r = await performResume(deps, session);
      if (r === "already-running") return m.agentAlreadyRunning;
      if (r === "missing-state") return m.agentResumeMissingState;
      return m.agentResumed;
    }
    case "exit": {
      log.info(`exiting agent session=${session}`);
      deps.queue.clearSession(session);
      // Route through the agent runner (both claude and codex: Ctrl-C + `/exit`),
      // not the hardcoded bridge.sendExit it used to call.
      await deps.agent.exit(session);
      deps.configResolver.invalidate(session);
      return m.agentExited;
    }
    case "restart": {
      log.info(`restarting agent session=${session}`);
      await deps.agent.gracefulRestartWithContinue(session);
      deps.configResolver.invalidate(session);
      return m.agentRestarted;
    }
    case "esc": {
      log.info(`sending esc session=${session}`);
      await deps.agent.interrupt(session);
      return m.sentEsc;
    }
    case "interrupt": {
      log.info(`sending ctrl-c session=${session}`);
      await deps.bridge.sendRawKey("C-c", session);
      return m.interrupted;
    }
    case "clear": {
      log.info(`sending /clear session=${session}`);
      await sendContextReset(deps, session, "clear");
      return m.clearedContext;
    }
    case "compact": {
      log.info(`sending /compact session=${session}`);
      await sendContextReset(deps, session, "compact");
      return m.compactedContext;
    }
    case "enter": {
      log.info(`sending enter session=${session}`);
      await deps.bridge.sendRawKey("C-m", session);
      return m.sentEnter;
    }
    case "up": {
      log.info(`sending up session=${session}`);
      await deps.bridge.sendRawKey("Up", session);
      return m.sentUp;
    }
    case "down": {
      log.info(`sending down session=${session}`);
      await deps.bridge.sendRawKey("Down", session);
      return m.sentDown;
    }
    case "left": {
      log.info(`sending left session=${session}`);
      await deps.bridge.sendRawKey("Left", session);
      return m.sentLeft;
    }
    case "right": {
      log.info(`sending right session=${session}`);
      await deps.bridge.sendRawKey("Right", session);
      return m.sentRight;
    }
    case "tab": {
      log.info(`sending tab session=${session}`);
      await deps.bridge.sendRawKey("Tab", session);
      return m.sentTab;
    }
    case "status": {
      log.info(`checking status session=${session}`);
      const running = await deps.agent.checkIfRunning(session);
      const channel = chatChannelOrDefault(msg.channel);
      return buildAgentStatusReport(deps, session, channel, running);
    }
    default: {
      const _exhaustive: never = msg.action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}

async function waitUntilInputReadyForMessage(
  msg: QueuedMessage,
  deps: HandlerDeps,
  session: string,
): Promise<void> {
  if (msg.origin !== "system") {
    await deps.agent.waitUntilInputReady(session);
    return;
  }
  const maxWaitMs =
    msg.maxWaitDoneTotalMs ??
    (deps.config as { maxWaitDoneTotalMs?: number }).maxWaitDoneTotalMs ??
    0;
  if (maxWaitMs <= 0) {
    await deps.agent.waitUntilInputReady(session);
    return;
  }
  const deadline = Date.now() + maxWaitMs;
  const retryDelayMs = 1000;
  let attempts = 0;
  let lastError: unknown = new Error("agent input surface not ready before retry deadline");
  while (Date.now() < deadline) {
    attempts++;
    try {
      await deps.agent.waitUntilInputReady(session);
      if (attempts > 1) {
        log.info(
          `system prompt input surface became ready session=${session} attempts=${attempts}`,
        );
      }
      return;
    } catch (err) {
      lastError = err;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      log.warn(`system prompt input surface not ready; retrying session=${session}`, {
        err,
        data: { attempts, remainingMs },
      });
      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }
  throw normalizeError(lastError);
}

function queuedMessageText(msg: QueuedMessage): string {
  const text = (msg as { text?: string }).text;
  return typeof text === "string" ? text : "";
}

function chatChannelOrDefault(channel: QueuedMessage["channel"]): "telegram" | "lark" {
  return channel === "lark" ? "lark" : "telegram";
}
