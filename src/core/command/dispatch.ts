import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { claudeBinFromStartCommand, claudeStartCommandWithSessionId } from "../../shared/config.js";
import type { AgentKind } from "../../shared/types.js";
import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import { resolveAgentKind, setAgentKind } from "../agents/agentKindMap.js";
import { recordLiveSessionId } from "../agents/live-session-id.js";
import { profileFor } from "../agents/registry.js";
import { setStartCommand } from "../agents/startCommandMap.js";
import type { HandlerDeps } from "../deps.js";
import { messages } from "../i18n/index.js";
import { getPathBySession } from "../projects/sessionPathMap.js";
import { sendContextReset } from "./context-reset.js";
import type { QueuedMessage } from "./queue.js";

const log = createLogger("command.dispatch");

/** Derive the AgentKind for a start command by matching against startCommands config. */
function agentKindForCommand(deps: HandlerDeps, command: string | undefined): AgentKind {
  if (command === undefined) return "claude";
  return deps.config.startCommands.find((c) => c.command === command)?.agent ?? "claude";
}

// Shell startup files a user's interactive shell sources — where an alias or
// function (e.g. `alias claude-stella=…`) is typically defined.
const SHELL_RC_FILES = [".zshrc", ".bashrc", ".bash_profile", ".zprofile", ".profile"] as const;

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
  for (const file of SHELL_RC_FILES) {
    try {
      if (re.test(readFileSync(nodePath.join(homedir(), file), "utf8"))) return true;
    } catch {
      // rc file may not exist — skip it
    }
  }
  return false;
}

export function assertClaudeBinaryAccessible(claudeStartCommand: string): void {
  const bin = claudeBinFromStartCommand(claudeStartCommand);
  if (nodePath.isAbsolute(bin)) {
    try {
      accessSync(bin, constants.X_OK);
      return;
    } catch {
      throw new Error(`Claude binary not found or not executable: ${bin}`);
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(nodePath.join(dir, bin), constants.X_OK);
      return;
    } catch {
      // continue searching
    }
  }
  // Not an executable on PATH — but a shell alias/function (e.g. in ~/.zshrc) is
  // a valid launcher too, since the command runs in the session's interactive
  // shell. Accept it rather than failing the pre-flight.
  if (definedInShellRc(bin)) return;
  throw new Error(`Claude binary "${bin}" not found in PATH`);
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
  setAgentKind(session, kind);
  // Record the EXACT launch command (flavor), so reboot recovery relaunches this
  // one, not the primary default. Persist the base command (without --session-id).
  setStartCommand(session, baseCommand);
  // Claude lets us pin the conversation id at launch (`--session-id`), so the bot
  // OWNS the exact id deterministically — no fragile lsof capture, and Free
  // Projects sharing a cwd stay unambiguous on resume. Codex can't pre-assign;
  // its id is read from the live rollout after start (resolveLiveTranscript).
  let launchCommand = baseCommand;
  if (kind === "claude") {
    const sessionId = randomUUID();
    launchCommand = claudeStartCommandWithSessionId(baseCommand, sessionId);
    recordLiveSessionId(session, sessionId);
  }
  await deps.agent.start(session, launchCommand);
  deps.configResolver.invalidate(session); // new process → re-detect config dir
  return "started";
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
  setAgentKind(session, agentKindForCommand(deps, command));
  setStartCommand(session, baseCommand); // keep the recorded flavor in sync
  await deps.agent.gracefulRestartWithContinue(session, command);
  deps.configResolver.invalidate(session); // new process → re-detect config dir
}

/**
 * The protocol-agnostic command layer. Given a queued message (an action + the
 * session it targets) and the core service bundle, perform the work against
 * tmux/Claude and return the plain-text result. Knows nothing about Telegram,
 * grammy, chats, or rendering — adapters wrap this and present the string.
 */

export const MESSAGE_ACTIONS = [
  "text",
  "start",
  "exit",
  "restart",
  "esc",
  "interrupt",
  "clear",
  "compact",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "tab",
  "status",
] as const;

export type MessageAction = (typeof MESSAGE_ACTIONS)[number];

export function isMessageAction(action: string): action is MessageAction {
  return (MESSAGE_ACTIONS as readonly string[]).includes(action);
}

/**
 * Precondition each action requires of the live agent, enforced in one place:
 *   "running" — needs a live agent because acting on a bare shell is harmful or
 *               confusing: a prompt or a "/clear" typed into a shell RUNS as a
 *               shell command, and there's nothing to exit.
 *   "absent"  — must have NO live agent (start would spawn a second one).
 *   null      — tolerant. Raw keys and interrupts are harmless on a bare pane AND
 *               are the user's escape hatch precisely when agent-state is uncertain
 *               (a startup prompt, a stuck pane) — guarding them would block it.
 *               restart resumes whether alive or dead; status is read-only.
 */
const ACTION_PRECONDITION: Record<MessageAction, "running" | "absent" | null> = {
  text: "running",
  start: "absent",
  exit: "running",
  clear: "running",
  compact: "running",
  restart: null,
  esc: null,
  interrupt: null,
  enter: null,
  up: null,
  down: null,
  left: null,
  right: null,
  tab: null,
  status: null,
};

export async function executeMessage(msg: QueuedMessage, deps: HandlerDeps): Promise<string> {
  const m = messages(msg.channel ?? "telegram");
  const session = msg.sessionName;
  if (!session) return m.doneShort;
  if (!isMessageAction(msg.action)) {
    throw new Error(`Unknown action: ${msg.action}`);
  }

  log.info(`action=${msg.action} session=${session} text_len=${msg.text?.length ?? 0}`);

  // Single precondition gate for every mutating action (see ACTION_PRECONDITION):
  // never type into a wrong-state pane, never spawn a second agent.
  const precond = ACTION_PRECONDITION[msg.action];
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
      log.info(`sending keys session=${session}`);
      await deps.bridge.sendKeys(msg.text, session);
      log.info(`keys sent, waiting for done session=${session}`);

      // Wait in maxWaitDoneMs rounds up to maxWaitDoneTotalMs total. The first
      // expired round sends a one-time "still running" notice (when the adapter
      // provided a notify channel) and waiting continues — so long tasks resolve
      // with their real result instead of a partial snapshot, and nothing gets
      // typed into a still-busy pane. Past the horizon, give up with partials.
      let rawResult: string;
      try {
        let round = await deps.agent.waitUntilDone(session);
        let waitedMs = deps.config.maxWaitDoneMs;
        let noticed = false;
        while (!round.done && waitedMs < deps.config.maxWaitDoneTotalMs) {
          if (!noticed) {
            msg.notify?.(m.taskStillRunningNotice);
            noticed = true;
          }
          log.info(`still running session=${session} waited=${waitedMs}ms, continuing to wait`);
          round = await deps.agent.waitUntilDone(session);
          waitedMs += deps.config.maxWaitDoneMs;
        }
        if (!round.done) {
          log.warn(`gave up waiting session=${session} after ${waitedMs}ms`);
          return m.taskStillRunning(deps.output.process(round.output));
        }
        rawResult = round.output;
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
      const profile = profileFor(await resolveAgentKind(deps.configResolver, session));
      log.info(`looking up history session=${session} path=${projectPath}`);
      const historyReply = await profile.getLatestReply(
        deps.configResolver,
        session,
        projectPath,
        msg.text,
      );
      if (historyReply?.trim()) {
        log.info(`history reply found len=${historyReply.length}`);
        const maxLen = deps.config.maxMessageLength - 100;
        if (historyReply.length > maxLen) {
          return `${historyReply.slice(0, maxLen)}\n\n${m.contentTruncated}`;
        }
        return historyReply;
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
      const channel = msg.channel ?? "telegram";
      const profile = profileFor(await resolveAgentKind(deps.configResolver, session));
      return profile.buildStatusReport(deps, session, channel, running);
    }
    default: {
      const _exhaustive: never = msg.action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}
