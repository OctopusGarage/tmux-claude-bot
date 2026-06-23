import type { Bot } from "grammy";
import { resolveAgentKind } from "../../core/agents/agentKindMap.js";
import { profileFor } from "../../core/agents/registry.js";
import { orphanLabel } from "../../core/agents/takeover.js";
import { findAdoptableOrphans } from "../../core/agents/takeover-service.js";
import { applyAutopilotVerb } from "../../core/autopilot/controls.js";
import { formatGoalsList } from "../../core/autopilot/goals/goals-view.js";
import { AutopilotStore } from "../../core/autopilot/state-store.js";
import { buildHelpBody, getTelegramActions } from "../../core/command/action-registry.js";
import { startDisposition } from "../../core/command/dispatch.js";
import { buildDashboard } from "../../core/dashboard/dashboard.js";
import { formatDashboardForChat } from "../../core/dashboard/dashboard-view.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages, resolveUiLang, setUiLang, UI_LANGS } from "../../core/i18n/index.js";
import { defaultProbes, renderDoctorReport, runDoctorChecks } from "../../core/infra/doctor.js";
import {
  defaultSystemLoadProbes,
  gatherSystemLoad,
  renderSystemLoad,
} from "../../core/infra/system-load.js";
import { queryLogs } from "../../core/logs/log-query.js";
import { formatLogsForChat, logsArgToFilter } from "../../core/logs/logs-view.js";
import {
  createSubfolder,
  isAwaitingFolderName,
  startBrowse,
} from "../../core/projects/dir-browser.js";
import { consumeFreeLabel, isAwaitingFreeLabel } from "../../core/projects/free-label-prompt.js";
import { FREE_PROJECT_LIMIT } from "../../core/projects/free-projects.js";
import { createFreeProject, createProjectFromPath } from "../../core/projects/project-ops.js";
import { getPathBySession } from "../../core/projects/sessionPathMap.js";
import { runWorkspaceCommand } from "../../core/projects/workspace-command.js";
import { parseInputsLimit } from "../../core/read/recent-inputs.js";
import { runBatchCommand } from "../../core/scheduler/batch-command.js";
import { parsePeekLines } from "../../core/session/output.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { createLogger } from "../../shared/utils/logger.js";
import { handleCallbackQuery } from "./callbacks.js";
import { createRestoredMessage, handleQueuedCommand } from "./executor.js";
import {
  buildIdleKeyboard,
  buildLangKeyboard,
  buildOrphanKeyboard,
  buildRecentKeyboard,
  buildSessionsKeyboard,
  buildStartPickerKeyboard,
} from "./keyboards.js";
import { MSG } from "./messages.js";
import {
  addRecentProjectBySid,
  recentProjectButtons,
  removeProjectBySession,
  resolveAliveSessionByShortId,
  startOrPickAfterCreate,
  switchToProject,
} from "./project-ops.js";
import { runPromptWithProgress } from "./prompt-lifecycle.js";
import type { Tone } from "./replies.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { tgScope } from "./scope.js";
import { resolveSessionFromReply } from "./session.js";
import {
  replyCreateProject,
  sendAliveList,
  sendBrowse,
  sendHistory,
  sendInputs,
  sendPeek,
  sendQueueStatus,
  sendRecoverPreview,
  sendStatusInstall,
} from "./views.js";

const log = createLogger("telegram.handlers");

export function registerHandlers(bot: Bot, deps: HandlerDeps, replyTarget: ReplyTargetMap): void {
  // Restore this channel's persisted backlog on boot. Drop ONLY the Telegram
  // channel — Lark restores + drops its own in startLark, so a Telegram+Lark
  // deployment loses neither side's queue regardless of which starts first.
  const persisted = deps.queue.loadPersisted();
  if (persisted.length > 0) {
    let restored = 0;
    for (const p of persisted) {
      if (p.channel === "lark") continue; // Lark restores its own (startLark)
      deps.queue.enqueue(createRestoredMessage(p, bot));
      restored++;
    }
    deps.queue.clearPersistedChannel("telegram"); // legacy no-channel entries count as telegram
    if (restored > 0) log.info("queue restored", { channel: "telegram", data: { restored } });
  }

  bot.command("lang", async (ctx) => {
    const arg = (ctx.message?.text ?? "").split(/\s+/)[1]?.trim();
    const labelOf = (l: string): string => UI_LANGS.find((x) => x.code === l)?.label ?? l;
    if (!arg) {
      const current = resolveUiLang("telegram");
      await reply(ctx, "info", messages("telegram").uiLangCurrent(labelOf(current)), {
        replyTarget,
        replyMarkup: buildLangKeyboard(current),
      });
      return;
    }
    // Match case-insensitively so a typed `/lang zh-TW` resolves despite the hyphen/case.
    const code = UI_LANGS.find((x) => x.code.toLowerCase() === arg.toLowerCase())?.code;
    if (!code) {
      await reply(ctx, "err", "用法 / Usage: /lang <en|zh|zh-TW|yue|ja|es>", { replyTarget });
      return;
    }
    setUiLang("telegram", code);
    await reply(ctx, "info", messages("telegram").uiLangSet(labelOf(code)), { replyTarget });
  });

  bot.command("help", async (ctx) => {
    await reply(ctx, "help", buildHelpBody("telegram", "telegram"));
  });

  for (const action of getTelegramActions()) {
    const a = action;
    bot.command(a, async (ctx) => {
      // `/start` is rejected when an agent is already running (no pointless
      // picker). Otherwise `/start`/`/restart` with multiple launch commands show
      // the flavor picker. Falls through to the queued action for a single command
      // or no current project.
      if (a === "start" || a === "restart") {
        const session = await deps.currentProject.get(tgScope(ctx));
        if (session) {
          const mode = a === "restart" ? "restart" : "start";
          const disp = await startDisposition(deps, session, mode);
          if (disp === "already-running") {
            await reply(ctx, "ok", messages("telegram").agentAlreadyRunning, {
              session,
              replyTarget,
            });
            return;
          }
          if (disp === "pick") {
            await reply(ctx, "info", messages("telegram").startPickerPrompt, {
              session,
              replyMarkup: buildStartPickerKeyboard(
                deps.config.startCommands,
                sessionShortId(session),
                mode,
              ),
              replyTarget,
            });
            return;
          }
        }
      }
      await handleQueuedCommand(ctx, deps, a, undefined, replyTarget);
    });
  }

  bot.command("peek", async (ctx) => {
    const session = await resolveSessionFromReply(ctx, replyTarget, deps);
    if (!session) {
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    // `/peek N` captures N lines of scrollback (paged across messages as needed).
    const peekArg = (ctx.message?.text ?? "").trim().split(/\s+/)[1];
    await sendPeek(ctx, deps, session, replyTarget, parsePeekLines(peekArg));
  });

  // `/inputs [N]` — list the last N inputs you sent, tap one to re-run it.
  bot.command("inputs", async (ctx) => {
    const session = await resolveSessionFromReply(ctx, replyTarget, deps);
    if (!session) {
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    const arg = (ctx.message?.text ?? "").trim().split(/\s+/)[1];
    await sendInputs(ctx, deps, session, replyTarget, parseInputsLimit(arg));
  });

  // List claude processes running outside tmux; tap one to take it over.
  bot.command("adopt", async (ctx) => {
    const orphans = await findAdoptableOrphans();
    if (orphans.length === 0) {
      await reply(ctx, "info", messages("telegram").adoptEmpty, { replyTarget });
      return;
    }
    const buttons = orphans.map((o) => ({ pid: o.pid, label: orphanLabel(o) }));
    await reply(ctx, "info", messages("telegram").adoptTitle, {
      replyMarkup: buildOrphanKeyboard(buttons),
      replyTarget,
    });
  });

  // Reboot recovery: after the machine restarts (tmux gone), preview every project
  // that would be recreated + relaunched, then execute on confirm.
  bot.command("recover", async (ctx) => {
    await sendRecoverPreview(ctx, deps, replyTarget);
  });

  // Install usage reporting into the running claudes' config dirs.
  bot.command("status_install", async (ctx) => {
    await sendStatusInstall(ctx, "scan", replyTarget);
  });

  // Project management commands (direct execution)
  // No path → open the Finder-style directory browser; a path → create directly.
  bot.command("add_project", async (ctx) => {
    const arg = (ctx.message?.text ?? "").split(" ").slice(1).join(" ").trim();
    if (!arg) {
      await sendBrowse(ctx, startBrowse(tgScope(ctx), deps.config.cdAllowedDirs));
      return;
    }
    await replyCreateProject(
      ctx,
      deps,
      await createProjectFromPath(deps, tgScope(ctx), arg),
      replyTarget,
    );
  });

  bot.command("new_free", async (ctx) => {
    const session = await handleNewFreeCommand(ctx, deps, tgScope(ctx), async (kind, text) => {
      await reply(ctx, kind, text);
    });
    if (session) await startOrPickAfterCreate(deps, ctx, session, replyTarget);
  });

  bot.command("current_project", async (ctx) => {
    const session = await deps.currentProject.get(tgScope(ctx));
    if (!session) {
      await reply(ctx, "err", messages("telegram").noCurrentProjectSet);
      return;
    }
    const exists = await deps.bridge.hasSession(session);
    const pathPart = getPathBySession(session) ?? session;
    const status = exists
      ? messages("telegram").currentActive
      : messages("telegram").currentNotFound;
    await reply(ctx, "list", messages("telegram").currentProjectTitle, {
      session,
      body: `${pathPart}\n${status}`,
    });
  });

  bot.command("list_alive_projects", async (ctx) => {
    await sendAliveList(ctx, deps);
  });

  bot.command("list_recent_projects", async (ctx) => {
    const buttons = await recentProjectButtons(deps, tgScope(ctx));
    if (buttons.length === 0) {
      await reply(ctx, "list", messages("telegram").noRecentProjects);
      return;
    }
    // No body — the buttons already show each project name + status (✅/🔀/➕).
    await reply(ctx, "list", messages("telegram").recentListTitleN(buttons.length), {
      replyMarkup: buildRecentKeyboard(buttons),
    });
  });

  bot.command("queue_status", async (ctx) => {
    await sendQueueStatus(ctx, deps);
  });

  bot.command("doctor", async (ctx) => {
    const report = await runDoctorChecks(defaultProbes());
    await reply(ctx, "info", renderDoctorReport(report, { redacted: true }));
  });

  bot.command("sessions", async (ctx) => {
    const scope = tgScope(ctx);
    const sessionName = await deps.currentProject.get(scope);
    if (!sessionName) {
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    const projectPath = getPathBySession(sessionName);
    if (!projectPath) {
      await reply(ctx, "err", messages("telegram").noPathMapping);
      return;
    }
    const profile = profileFor(await resolveAgentKind(deps.configResolver, sessionName));
    const sessions = await profile.listSessions(deps.configResolver, sessionName, projectPath);
    if (sessions.length === 0) {
      await reply(ctx, "list", messages("telegram").noSessions);
      return;
    }
    await reply(ctx, "list", messages("telegram").sessionsTitle(sessions.length), {
      replyMarkup: buildSessionsKeyboard(sessions),
    });
  });

  bot.command("history", async (ctx) => {
    const args = (ctx.message?.text ?? "").split(" ").slice(1);
    let index = 0; // 0 = most recent (default)
    const arg0 = args[0];
    if (arg0 !== undefined) {
      const parsed = parseInt(arg0, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        index = parsed - 1;
      }
    }

    const session = await resolveSessionFromReply(ctx, replyTarget, deps);
    if (!session) {
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    await sendHistory(ctx, deps, session, index, replyTarget);
  });

  // Owner-only (the auth guard drops non-allowlisted users before this runs).
  // Shows recent WARN/ERROR for the current session, a specific trace, or the
  // last N — rendered as a code block.
  bot.command("logs", async (ctx) => {
    const arg = (ctx.message?.text ?? "").split(/\s+/).slice(1)[0]?.trim();
    const session = await resolveSessionFromReply(ctx, replyTarget, deps);
    const filter = logsArgToFilter(arg, session ?? undefined);
    if (!filter) {
      await reply(ctx, "err", messages("telegram").noLogsContext);
      return;
    }
    const body = formatLogsForChat(queryLogs(filter), { maxChars: 3500 });
    await reply(ctx, "view", messages("telegram").logsTitle, {
      session: session ?? undefined,
      body,
      code: true,
      replyTarget,
    });
  });

  // Owner-only (the auth guard drops non-allowlisted users before this runs).
  // Renders the global dashboard — every live session plus bot-level totals — as
  // plain text: the emoji + "·"-separated lines read cleanly in Telegram's
  // proportional font; a monospace code block looked clunky (and the format is
  // separator-based, not column-aligned, so it needs no monospace).
  bot.command("dashboard", async (ctx) => {
    const snap = await buildDashboard(deps);
    const body = formatDashboardForChat(snap, { maxChars: 3500 });
    await reply(ctx, "view", messages("telegram").dashboardTitle, {
      body,
      replyTarget,
    });
  });

  // Owner-only: machine load / thermal / top CPU / runaway-orphan shells — check
  // from your phone whether the Mac is overloaded or overheating.
  bot.command("sysload", async (ctx) => {
    const report = await gatherSystemLoad(defaultSystemLoadProbes());
    await reply(ctx, "view", messages("telegram").sysloadTitle, {
      body: renderSystemLoad(report),
      replyTarget,
    });
  });

  // Per-session autopilot control: /autopilot [on|off|keepalive on|off|stop]
  // Resolve the target session the same way /logs does (reply-routing first,
  // then the chat's current project), so it works from any reply context.
  bot.command("autopilot", async (ctx) => {
    const session = await resolveSessionFromReply(ctx, replyTarget, deps);
    if (!session) {
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    const arg = (ctx.match ?? "").toString();
    const body = applyAutopilotVerb(
      new AutopilotStore(),
      session,
      arg,
      messages("telegram"),
      deps.config.autopilot.maxRounds,
    );
    await reply(ctx, "view", messages("telegram").autopilotTitle, {
      session,
      body,
      replyTarget,
    });
  });

  // Owner-only: batch scheduler status and control.
  bot.command("batch", async (ctx) => {
    const arg = (ctx.match ?? "").toString();
    const body = runBatchCommand(arg);
    await reply(ctx, "view", "Batch", { body, replyTarget });
  });

  bot.command("goals", async (ctx) => {
    const body = formatGoalsList(messages("telegram"));
    await reply(ctx, "view", messages("telegram").goalsTitle, {
      body,
      replyTarget,
    });
  });

  bot.command("ws", async (ctx) => {
    const raw = (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();
    await runWorkspaceCommand(
      deps,
      "telegram",
      String(ctx.chat?.id ?? 0),
      raw,
      async (kind, text) => {
        await reply(ctx, kind, text);
      },
    );
  });

  // Inline-button taps: control panel (esc/interrupt/enter/restart) and the
  // project list's switch/remove buttons.
  bot.on("callback_query:data", (ctx) => handleCallbackQuery(ctx, deps, replyTarget));

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat?.id ?? "unknown";
    log.info(`message received chat=${chatId} text_len=${text.length}`);

    if (text.length > deps.config.maxInboundLength) {
      log.warn(`message too long chat=${chatId} len=${text.length}`);
      await reply(
        ctx,
        "err",
        messages("telegram").messageTooLong(text.length, deps.config.maxInboundLength),
      );
      return;
    }

    // Free-project naming: if a "🆓 new free project" label is awaited for this
    // chat, this message IS the label — create the free project ("-" = skip name).
    if (isAwaitingFreeLabel(tgScope(ctx))) {
      const scope = tgScope(ctx);
      consumeFreeLabel(scope);
      const label = text.trim() === "-" ? "" : text.trim();
      const session = await createFreeAndReply(deps, scope, label, async (kind, body) => {
        await reply(ctx, kind, body);
      });
      if (session) await startOrPickAfterCreate(deps, ctx, session, replyTarget);
      return;
    }

    // Directory browser: if a "new folder" name is awaited for this chat, this
    // message IS that name — create it and re-open the browser in the new folder.
    if (isAwaitingFolderName(tgScope(ctx))) {
      const result = createSubfolder(tgScope(ctx), text, deps.config.cdAllowedDirs);
      const tm = messages("telegram");
      if (result.ok) {
        await sendBrowse(ctx, result.view);
      } else if (result.reason !== "expired") {
        const msg =
          result.reason === "exists"
            ? tm.browseNewFolderExists
            : result.reason === "invalid"
              ? tm.browseNewFolderInvalid
              : tm.browseNewFolderError;
        await reply(ctx, "err", msg, { replyTarget });
      }
      return;
    }

    // Check if this message is a reply to one of our sent messages
    const replyToMsg = ctx.message.reply_to_message;
    let targetSession: string | null = null;
    if (replyToMsg) {
      // Reply to a "已排队" ack with new text → rewrite that still-waiting message
      // in place (keeps its queue position). TERMINAL unless it wasn't one of our
      // acks: a rewrite blocked by dedup is reported, never silently re-enqueued as a
      // fresh prompt (which dedup would then drop, losing the edit).
      const rw = deps.queue.rewriteByAck(String(replyToMsg.message_id), ctx.chat?.id ?? 0, text);
      if (rw.kind !== "not-found") {
        const m = messages("telegram");
        const ok = rw.kind === "rewritten";
        await reply(ctx, ok ? "ok" : "warn", ok ? m.queueItemRewritten : m.duplicateIgnored, {
          session: rw.session, // 📂 project tag + records the confirmation as a reply-target
          replyTarget,
        });
        return;
      }
      targetSession = replyTarget.resolve(replyToMsg.message_id) ?? null;
      if (targetSession) {
        log.info(`reply detected msgId=${replyToMsg.message_id} → session=${targetSession}`);
      }
    }

    const switchMatch = text.match(/^\/switch_([a-zA-Z0-9]{6})$/);
    if (switchMatch) {
      const id = switchMatch[1] ?? "";
      try {
        const sessionName = await resolveAliveSessionByShortId(deps, id);
        if (!sessionName) {
          await reply(ctx, "err", MSG.noShortId(id), { replyTarget });
          return;
        }
        await switchToProject(deps, tgScope(ctx), sessionName);
        await reply(ctx, "ok", messages("telegram").switched, {
          session: sessionName,
          replyTarget,
        });
      } catch (err) {
        await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
      }
      return;
    }

    const removeMatch = text.match(/^\/remove_([a-zA-Z0-9]{6})$/);
    if (removeMatch) {
      const id = removeMatch[1] ?? "";
      try {
        const sessionName = await resolveAliveSessionByShortId(deps, id);
        if (!sessionName) {
          await reply(ctx, "err", MSG.noShortId(id), { replyTarget });
          return;
        }
        replyTarget.removeSession(sessionName);
        await removeProjectBySession(deps, sessionName);
        await reply(ctx, "ok", messages("telegram").removed, { session: sessionName, replyTarget });
      } catch (err) {
        await reply(ctx, "err", `${normalizeError(err).message}`, { replyTarget });
      }
      return;
    }

    const addProjectMatch = text.match(/^\/add_project_([a-zA-Z0-9]{6})$/);
    if (addProjectMatch) {
      await addRecentProjectBySid(deps, ctx, addProjectMatch[1] ?? "", replyTarget);
      return;
    }

    const currentSessionName = targetSession ?? (await deps.currentProject.get(tgScope(ctx)));
    if (!currentSessionName) {
      log.warn(`no current session chat=${chatId}`);
      await reply(ctx, "err", MSG.noSession);
      return;
    }
    replyTarget.record(ctx.message.message_id, currentSessionName);
    log.info(
      `currentSession=${currentSessionName} chat=${chatId} via=${targetSession ? "reply" : "currentProject"}`,
    );
    const isRunning = await deps.agent.checkIfRunning(currentSessionName);
    if (isRunning) {
      log.info(`enqueuing text message session=${currentSessionName} chat=${chatId}`);
      await runPromptWithProgress(ctx, deps, currentSessionName, text, replyTarget);
      return;
    }

    log.warn(`claude not running session=${currentSessionName} chat=${chatId}`);
    await reply(ctx, "err", MSG.notRunning, {
      session: currentSessionName,
      replyMarkup: buildIdleKeyboard(sessionShortId(currentSessionName)),
      replyTarget,
    });
  });
}

/**
 * Shared `/new_free [label]` logic, decoupled from grammY so it can be tested with
 * a plain reply sink. Creates a bare free project and reports the outcome.
 */
export async function handleNewFreeCommand(
  ctx: { message?: { text?: string | undefined } | undefined },
  deps: HandlerDeps,
  scope: string,
  send: (tone: Tone, text: string) => void | Promise<void>,
): Promise<string | null> {
  const label = (ctx.message?.text ?? "").split(" ").slice(1).join(" ").trim();
  return createFreeAndReply(deps, scope, label, send);
}

/** Create a free project for `label` (empty = unnamed) and report via `send`.
 * Returns the new session name when created (for the caller's start/pick step),
 * else null. Shared by `/new_free` and the button-driven label-capture flow. */
export async function createFreeAndReply(
  deps: HandlerDeps,
  scope: string,
  label: string,
  send: (tone: Tone, text: string) => void | Promise<void>,
): Promise<string | null> {
  const m = messages("telegram");
  const res = await createFreeProject(deps, scope, label);
  if (res.status === "created") {
    await send("info", m.freeProjectCreated(res.slot, label || null));
    return res.sessionName;
  }
  if (res.status === "limit") {
    await send("err", m.freeProjectLimit(FREE_PROJECT_LIMIT));
  } else {
    await send("err", m.errorPrefix(res.message));
  }
  return null;
}
