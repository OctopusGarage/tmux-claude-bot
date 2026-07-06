import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { getAgentRuntimeRecord } from "../../core/agents/agent-runtime-records.js";
import { resolveAgentKind } from "../../core/agents/agentKindMap.js";
import { readAgentRecentConversations, readAgentSessions } from "../../core/agents/read.js";
import { orphanLabel } from "../../core/agents/takeover.js";
import { findAdoptableOrphans } from "../../core/agents/takeover-service.js";
import { performStart } from "../../core/command/dispatch.js";
import { buildQueueStatusLines } from "../../core/command/queue-status.js";
import { buildDashboard } from "../../core/dashboard/dashboard.js";
import { formatDashboardForChat } from "../../core/dashboard/dashboard-view.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages, resolveUiLang } from "../../core/i18n/index.js";
import { defaultProbes, renderDoctorReport, runDoctorChecks } from "../../core/infra/doctor.js";
import { type ForeignAction, runStatusInstall } from "../../core/infra/status-install.js";
import {
  defaultSystemLoadProbes,
  gatherSystemLoad,
  renderSystemLoad,
} from "../../core/infra/system-load.js";
import { queryLogs } from "../../core/logs/log-query.js";
import { formatLogsForChat, logsArgToFilter } from "../../core/logs/logs-view.js";
import { startBrowse } from "../../core/projects/dir-browser.js";
import { getBinding, isProjectGroup, listBindings } from "../../core/projects/group-bindings.js";
import { chatScope } from "../../core/projects/project-manager.js";
import {
  type CreateProjectResult,
  createProjectFromPath,
  openRecentProjectBySid,
} from "../../core/projects/project-ops.js";
import {
  currentSelectionRow,
  projectPickerRows,
  projectPickerRowsFromRecentRows,
} from "../../core/projects/project-session-picker.js";
import { formatCurrentProjectSummary } from "../../core/projects/project-summary-view.js";
import { getPathBySession } from "../../core/projects/sessionPathMap.js";
import { runWorkspaceCommand } from "../../core/projects/workspace-command.js";
import { getRecentInputs, storeInputList } from "../../core/read/recent-inputs.js";
import { formatSingleConversation, type SessionEntry } from "../../core/read/transcript.js";
import { resolveWhisperLanguage } from "../../core/read/voice-support.js";
import { planRecovery } from "../../core/recovery/recover.js";
import {
  actionableCount,
  aliveCount,
  recoverPreviewList,
} from "../../core/recovery/recover-view.js";
import { DEFAULT_PEEK_LINES, renderPeekPaneChunks } from "../../core/session/output.js";
import { sleep } from "../../shared/utils/sleep.js";
import {
  browseCard,
  groupBoundCard,
  groupOverviewCard,
  groupPickerCard,
  inputsCard,
  langCard,
  orphanListCard,
  peekChunkCard,
  projectListCard,
  promptTranslateCard,
  recentListCard,
  recoverConfirmCard,
  startPickerCard,
  statusInstallCard,
  viewCard,
  voiceLangCard,
} from "./cards.js";
import { sendCard, sendError, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";

/** Resolve the chat's current project, or reply the short "no current project" hint
 * and return null. The one place the view handlers share this guard (was inlined in
 * every view). The enqueue path uses the richer {@link resolveSession} (recovery
 * card) instead — views just need the lightweight text hint. */
async function requireLarkSession(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<string | null> {
  const session = await deps.currentProject.get(chatScope("lark", chatId));
  if (!session) {
    await sendText(channel, chatId, messages("lark").noCurrentProjectShort);
    return null;
  }
  return session;
}

/** Send the voice recognition-language picker card (current language marked).
 * A click re-sends the picker with the ✅ moved (regular interactive card). */
export async function sendVoiceLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendCard(channel, chatId, voiceLangCard(resolveWhisperLanguage("lark")));
}

/** Send the prompt-translation picker card (current mode marked). */
export async function sendPromptTranslatePicker(
  channel: LarkChannel,
  chatId: string,
): Promise<void> {
  await sendCard(channel, chatId, promptTranslateCard());
}

/** Send the UI-language picker card (current language marked). */
export async function sendLangPicker(channel: LarkChannel, chatId: string): Promise<void> {
  await sendCard(channel, chatId, langCard(resolveUiLang("lark")));
}

/** Run the install health checks and send the redacted report. */
export async function sendDoctor(channel: LarkChannel, chatId: string): Promise<void> {
  const report = await runDoctorChecks(defaultProbes());
  await sendText(channel, chatId, renderDoctorReport(report, { redacted: true }));
}

/**
 * Read-side renderers for the Lark adapter: fetch state (project lists, tmux
 * pane, history, queue) and render it into cards/text. Mirrors
 * telegram/views.ts. No mutation except `addProject`/`addRecentBySid`, which
 * create the project the way the Telegram `/add_project` handler does.
 */

/** The alive-projects list as a tappable switch/remove card. */
export async function sendAliveList(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  try {
    const buttons = await projectPickerRows(deps, chatScope("lark", chatId), "project-sessions");
    await sendCard(channel, chatId, projectListCard(buttons, isProjectGroup(chatId)));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** The recent-projects list as a tappable switch/create card. */
export async function sendRecentList(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  try {
    const buttons = await projectPickerRows(deps, chatScope("lark", chatId), "recent-projects");
    await sendCard(channel, chatId, recentListCard(buttons, isProjectGroup(chatId)));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** List unmanaged claude processes; each card row offers a take-over
 * button. Mirrors Telegram's `/adopt`. */
export async function sendOrphanList(channel: LarkChannel, chatId: string): Promise<void> {
  try {
    const orphans = await findAdoptableOrphans();
    if (orphans.length === 0) {
      await sendText(channel, chatId, messages("lark").adoptEmpty);
      return;
    }
    const rows = orphans.map((o) => ({ pid: o.pid, label: orphanLabel(o) }));
    await sendCard(channel, chatId, orphanListCard(rows));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Preview what reboot recovery would restore, with a confirm button. Mirrors
 * Telegram's /recover (p2p-only, gated by the caller). */
export async function sendRecoverPreview(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  try {
    const plan = await planRecovery(deps);
    const n = actionableCount(plan);
    if (n === 0) {
      // Nothing to recover: nothing tracked, or everything tracked is running.
      await sendText(
        channel,
        chatId,
        plan.length === 0
          ? messages("lark").recoverEmpty
          : messages("lark").recoverAllRunning(plan.length, recoverPreviewList(plan)),
      );
      return;
    }
    await sendCard(
      channel,
      chatId,
      recoverConfirmCard(n, aliveCount(plan), recoverPreviewList(plan)),
    );
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Run the usage-reporting install and render the result card (with the
 * foreign-statusLine choice buttons when needed). Mirrors `/status_install`. */
export async function sendStatusInstall(
  channel: LarkChannel,
  chatId: string,
  action: ForeignAction = "scan",
): Promise<void> {
  try {
    const res = await runStatusInstall("lark", action);
    await sendCard(channel, chatId, statusInstallCard(res.lines.join("\n"), res.foreignPending));
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Capture and send the current session pane in a view card. */
export async function sendPeek(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  lines: number = DEFAULT_PEEK_LINES,
): Promise<void> {
  const session = await requireLarkSession(channel, deps, chatId);
  if (!session) return;
  try {
    const snapshot = await deps.bridge.capturePaneColored(session, lines);
    const chunks = renderPeekPaneChunks(snapshot, deps.output, lines, deps.config.maxMessageLength);
    const running = await deps.agent.checkIfRunning(session);
    const group = isProjectGroup(chatId);
    const base = messages("lark").paneTitle;
    if (chunks.length === 0) {
      const mid = await sendCard(channel, chatId, viewCard(base, "", group, running));
      if (mid) recordReplyTarget(mid, session);
      return;
    }
    // Page across cards; only the LAST (bottom) card carries the control panel.
    let lastMid: string | undefined;
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      const title = chunks.length > 1 ? `${base} ${i + 1}/${chunks.length}` : base;
      const card = last ? viewCard(title, chunk, group, running) : peekChunkCard(title, chunk);
      const mid = await sendCard(channel, chatId, card);
      if (last) lastMid = mid;
    }
    if (lastMid) recordReplyTarget(lastMid, session);
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Send the Nth-most-recent conversation round for the current session (0 = latest). */
export async function sendHistory(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  index: number,
): Promise<void> {
  const session = await requireLarkSession(channel, deps, chatId);
  if (!session) return;
  try {
    const projectPath = getPathBySession(session);
    if (!projectPath) {
      await sendText(channel, chatId, messages("lark").noPathMapping);
      return;
    }
    const rounds = await readAgentRecentConversations(deps.configResolver, session, projectPath);
    if (rounds.length === 0) {
      await sendText(channel, chatId, messages("lark").noHistory);
      return;
    }
    if (index >= rounds.length) {
      await sendText(channel, chatId, messages("lark").onlyNRounds(rounds.length));
      return;
    }
    const round = rounds[index];
    if (round === undefined) return;
    const body = formatSingleConversation(round, index, rounds.length, "lark");
    const mid = await sendCard(
      channel,
      chatId,
      viewCard(
        messages("lark").historyTitle,
        body,
        isProjectGroup(chatId),
        await deps.agent.checkIfRunning(session),
      ),
    );
    if (mid) recordReplyTarget(mid, session);
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** `/inputs [N]`: list the last N inputs you sent (tap one to fetch & edit it). */
export async function sendInputs(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  limit: number,
): Promise<void> {
  const session = await requireLarkSession(channel, deps, chatId);
  if (!session) return;
  try {
    const projectPath = getPathBySession(session);
    if (!projectPath) {
      await sendText(channel, chatId, messages("lark").noPathMapping);
      return;
    }
    const inputs = await getRecentInputs(deps, session, projectPath, limit);
    if (inputs.length === 0) {
      await sendText(channel, chatId, messages("lark").inputsEmpty);
      return;
    }
    const token = storeInputList(session, inputs);
    const mid = await sendCard(channel, chatId, inputsCard(inputs, token));
    if (mid) recordReplyTarget(mid, session);
  } catch (err) {
    await sendError(channel, chatId, err);
  }
}

/** Send recent WARN/ERROR logs for the current session, a trace, or last N, as a
 * view card. The handler only routes here from a 1:1 (p2p) chat with the
 * allow-listed owner, so logs never reach group members. */
export async function sendLogs(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  arg: string | undefined,
): Promise<void> {
  const session = await deps.currentProject.get(chatScope("lark", chatId));
  const filter = logsArgToFilter(arg, session ?? undefined);
  if (!filter) {
    await sendText(channel, chatId, messages("lark").noLogsContext);
    return;
  }
  const body = formatLogsForChat(queryLogs(filter), { maxChars: 3500 });
  const mid = await sendCard(
    channel,
    chatId,
    viewCard(messages("lark").logsTitle, body, isProjectGroup(chatId)),
  );
  if (mid && session) recordReplyTarget(mid, session);
}

/** Render the global dashboard — every live session plus bot-level totals — as a
 * view card. The handler only routes here from a 1:1 (p2p) chat with the
 * allow-listed owner, so host-wide system info never reaches group members. */
export async function sendDashboard(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const snap = await buildDashboard(deps);
  const body = formatDashboardForChat(snap, { maxChars: 3500 });
  await sendCard(
    channel,
    chatId,
    viewCard(messages("lark").dashboardTitle, body, isProjectGroup(chatId)),
  );
}

/** Machine load / thermal / top CPU / runaway-orphan shells. Mirrors /dashboard;
 * owner p2p only (the handler gates chatType). */
export async function sendSysload(channel: LarkChannel, chatId: string): Promise<void> {
  const report = await gatherSystemLoad(defaultSystemLoadProbes());
  await sendCard(
    channel,
    chatId,
    viewCard(messages("lark").sysloadTitle, renderSystemLoad(report), isProjectGroup(chatId)),
  );
}

/** Build and send the message-queue status (global + per-session). No control
 * buttons — matches Telegram, where queue status is plain text. */
export async function sendQueueStatus(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  await sendText(channel, chatId, buildQueueStatusLines(deps, "lark").join("\n"));
}

/** Report the current project (or that none is set). */
export async function sendCurrentProject(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const session = await requireLarkSession(channel, deps, chatId);
  if (!session) return;
  // Show the friendly label AND the full workspace directory underneath, so it's
  // clear which path the current project maps to (mirrors Telegram).
  const m = messages("lark");
  const summary = await currentSelectionRow(deps, chatScope("lark", chatId));
  if (!summary) return;
  await sendText(channel, chatId, formatCurrentProjectSummary(m, summary));
}

/** Validate + create a project from a raw path (the typed `/add_project <path>`). */
export async function addProject(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  rawPath: string,
): Promise<void> {
  await replyCreateProject(
    channel,
    deps,
    chatId,
    await createProjectFromPath(deps, chatScope("lark", chatId), rawPath),
  );
}

/** After a fresh project session is created: with multiple configured launch
 * commands, show the flavor picker card; with a single one, start it directly. */
export async function startOrPickAfterCreate(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  session: string,
): Promise<void> {
  if (deps.config.startCommands.length > 1) {
    await sendCard(channel, chatId, startPickerCard(deps.config.startCommands));
    return;
  }
  const only = deps.config.startCommands[0];
  const r = await performStart(deps, session, only?.command);
  await sendText(
    channel,
    chatId,
    r === "already-running"
      ? messages("lark").agentAlreadyRunning
      : messages("lark").agentStartedWith(only?.label ?? "claude"),
  );
}

/** Map a `createProjectFromPath` outcome to a Lark reply — shared by the typed
 * `/add_project <path>` and the directory-browser "create here" button. */
export async function replyCreateProject(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  result: CreateProjectResult,
): Promise<void> {
  const m = messages("lark");
  switch (result.status) {
    case "invalid":
      if (result.error === "not-a-directory")
        await sendText(channel, chatId, m.notADir(result.resolvedPath));
      else if (result.error === "not-found")
        await sendText(channel, chatId, m.dirNotExist(result.resolvedPath));
      else await sendText(channel, chatId, m.pathNotAllowedPath(result.resolvedPath));
      return;
    case "switched":
      await sendText(channel, chatId, m.alreadySwitched);
      return;
    case "created":
      await sendText(channel, chatId, m.projectCreatedPath(result.projectPath));
      await startOrPickAfterCreate(channel, deps, chatId, result.sessionName);
      return;
    case "error":
      await sendError(channel, chatId, new Error(result.message));
      return;
  }
}

/** Open the directory browser as a managed card (so navigation updates it in
 * place). Mirrors the Telegram `/add_project` no-arg flow. */
export async function sendBrowse(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const view = startBrowse(chatScope("lark", chatId), deps.config.cdAllowedDirs);
  // Regular (not managed/CardKit) card: CardKit-entity button callbacks don't
  // fire in some Feishu app setups, whereas interactive-message buttons do. Each
  // navigation re-sends a fresh card rather than updating in place.
  await sendCard(channel, chatId, browseCard(view));
}

/**
 * Switch to (or create) a recent project by its short id. Mirrors the create
 * branch of the Telegram `addRecentProjectBySid`. Shared by the recent-list
 * "create" button.
 */
export async function addRecentBySid(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  sid: string,
): Promise<void> {
  const m = messages("lark");
  const r = await openRecentProjectBySid(deps, chatScope("lark", chatId), sid);
  switch (r.status) {
    case "not-found":
      await sendText(channel, chatId, m.shortIdNotFound(sid));
      return;
    case "switched":
      await sendText(channel, chatId, m.switched);
      return;
    case "not-allowed":
      await sendText(channel, chatId, m.pathNotAllowedPath(r.projectPath));
      return;
    case "created":
      await sendText(channel, chatId, m.projectCreatedPath(r.projectPath));
      await startOrPickAfterCreate(channel, deps, chatId, r.sessionName);
      return;
    case "error":
      await sendError(channel, chatId, new Error(r.message));
      return;
  }
}

/**
 * Context-aware "project groups" menu (the 🗂 button). In a bound group it shows
 * the binding + restore/rebind/unbind; otherwise it shows recent projects each
 * with a "new group" button — so creating/managing groups needs no typing.
 */
export async function sendGroupMenu(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const binding = getBinding(chatId);
  if (binding) {
    const summary = (
      await projectPickerRows(deps, chatScope("lark", chatId), "recent-projects")
    ).find((b) => b.sessionName === binding.sessionName);
    await sendCard(
      channel,
      chatId,
      groupBoundCard(binding.label, {
        path: binding.workspacePath,
        ...(summary?.statusLine ? { statusLine: summary.statusLine } : {}),
      }),
    );
    return;
  }
  // From a private chat: show the EXISTING groups (so you can see what you have)
  // plus a picker of recent projects that don't yet have a group. Hide "new
  // group" for already-grouped projects (one workspace ↔ one group); the handler
  // also rejects it, but don't even offer the button.
  const bindings = listBindings();
  const allButtons = await projectPickerRows(deps, chatScope("lark", chatId), "recent-projects");
  const bySession = new Map(allButtons.map((b) => [b.sessionName, b]));
  const buttons = projectPickerRowsFromRecentRows(allButtons, "project-group-create");
  const groups = bindings.map(({ chatId: boundChatId, binding }) => {
    const statusLine = bySession.get(binding.sessionName)?.statusLine;
    return {
      label: binding.label,
      workspacePath: binding.workspacePath,
      chatId: boundChatId,
      ...(statusLine ? { statusLine } : {}),
    };
  });
  await sendCard(channel, chatId, groupOverviewCard(groups, buttons));
}

/** The recent-project picker in "bind" mode — used by the rebind button to pick a
 * new project for the current group. */
export async function sendGroupBindPicker(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const buttons = await projectPickerRows(deps, chatScope("lark", chatId), "project-group-bind");
  await sendCard(channel, chatId, groupPickerCard(buttons, "bind"));
}

/** Private-chat picker for "parallel project group": every recent project (including
 * ones that already have a group) gets an independent-session button that creates a NEW group on a
 * fresh independent session in that directory. */
export async function sendFreeGroupPicker(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
): Promise<void> {
  const buttons = await projectPickerRows(
    deps,
    chatScope("lark", chatId),
    "parallel-project-group",
  );
  await sendCard(channel, chatId, groupPickerCard(buttons, "free"));
}

/**
 * Handle `/ws <subcommand> [name]` — workspace save/use/list/remove.
 * `arg` is everything after `/ws` (e.g. "save my-project").
 */
export async function handleWsCommand(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  arg: string | undefined,
): Promise<void> {
  // Lark has no tone layer, so the reply kind is ignored — just send the text.
  await runWorkspaceCommand(deps, "lark", chatId, arg, (_kind, text) =>
    sendText(channel, chatId, text),
  );
}

function formatAgo(date: Date): string {
  const diffMin = Math.round((Date.now() - date.getTime()) / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.round(diffH / 24)}d`;
}

/**
 * List saved Claude sessions for the current project. If `arg` is a session
 * ID prefix, exit the current Claude and resume that session.
 */
export async function sendSessionsList(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  arg: string | undefined,
): Promise<void> {
  const m = messages("lark");
  const session = await requireLarkSession(channel, deps, chatId);
  if (!session) return;
  const projectPath = getPathBySession(session);
  if (!projectPath) {
    await sendText(channel, chatId, m.noPathMapping);
    return;
  }
  const listSessions = async (): Promise<SessionEntry[]> => {
    return readAgentSessions(deps.configResolver, session, projectPath);
  };

  if (arg) {
    const sessions = await listSessions();
    const match = sessions.find((s) => s.sessionId.startsWith(arg));
    if (!match) {
      await sendText(channel, chatId, m.noSessions);
      return;
    }
    // Resolve the live kind before exit — resolveAgentKind self-persists it, so
    // the post-exit dispatch resumes with the right runner (live detection
    // returns null once it's gone).
    await resolveAgentKind(deps.configResolver, session);
    await deps.bridge.sendExit(session);
    await sleep(2000);
    // Resume with the recorded launch flavor (e.g. claude-stella), not the runner
    // default, so the resumed session keeps its CLAUDE_CONFIG_DIR/flags.
    await deps.agent.startWithResume(
      session,
      match.sessionId,
      getAgentRuntimeRecord(session).startCommand ?? undefined,
    );
    deps.configResolver.invalidate(session);
    await sendText(channel, chatId, m.resumeStarted(match.sessionId.slice(0, 8)));
    return;
  }

  const sessions = await listSessions();
  if (sessions.length === 0) {
    await sendText(channel, chatId, m.noSessions);
    return;
  }
  const lines = [
    m.sessionsTitle(sessions.length),
    ...sessions.map((s, i) => `${i + 1}. \`${s.sessionId.slice(0, 8)}\` (${formatAgo(s.mtime)})`),
    "",
    "用 `/sessions <id前缀>` 恢复",
  ];
  await sendText(channel, chatId, lines.join("\n"));
}
