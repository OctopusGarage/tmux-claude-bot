import type { HandlerDeps } from "../deps.js";
import { messages } from "../i18n/index.js";
import { type Channel, chatScope } from "./project-manager.js";
import {
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  saveWorkspace,
  WORKSPACE_NAME_RE,
} from "./workspaces.js";

/** Reply tone for a workspace command outcome. Telegram maps these to its tone
 *  layer; Lark has none, so it just sends the text. */
export type WsReplyKind = "list" | "err" | "ok" | "info";

/**
 * Channel-agnostic `/ws <sub> [name]` handler (save / use / list / remove).
 * Both adapters were carrying an identical copy of this logic; only the reply
 * surface differed. The adapter supplies `send(kind, text)`; this owns the
 * parsing, validation, store mutations and message selection.
 *
 * `arg` is everything after `/ws` (e.g. "save my-project"). `chatId` is the
 * adapter's chat identity (Telegram stringifies its numeric id).
 */
export async function runWorkspaceCommand(
  deps: HandlerDeps,
  channel: Channel,
  chatId: string,
  arg: string | undefined,
  send: (kind: WsReplyKind, text: string) => Promise<void>,
): Promise<void> {
  const m = messages(channel);
  const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  const name = parts[1];

  if (sub === "list") {
    const all = listWorkspaces();
    if (all.length === 0) {
      await send("list", m.wsListEmpty);
      return;
    }
    await send(
      "list",
      [m.wsListTitle, ...all.map((w) => m.wsListItem(w.name, w.session))].join("\n"),
    );
    return;
  }

  if (sub === "save") {
    if (!name || !WORKSPACE_NAME_RE.test(name)) {
      await send("err", name ? m.wsInvalidName : m.wsUsage);
      return;
    }
    const session = await deps.currentProject.get(chatScope(channel, chatId));
    if (!session) {
      await send("err", m.wsNoCurrentProject);
      return;
    }
    saveWorkspace(name, session);
    await send("ok", m.wsSaved(name, session));
    return;
  }

  if (sub === "use") {
    if (!name || !WORKSPACE_NAME_RE.test(name)) {
      await send("err", name ? m.wsInvalidName : m.wsUsage);
      return;
    }
    const session = getWorkspace(name);
    if (!session) {
      await send("err", m.wsNotFound(name));
      return;
    }
    if (!(await deps.bridge.hasSession(session))) {
      await send("err", m.wsSessionGone(name));
      return;
    }
    await deps.currentProject.set(chatScope(channel, chatId), session);
    await send("ok", m.wsUsed(name));
    return;
  }

  if (sub === "remove") {
    if (!name || !WORKSPACE_NAME_RE.test(name)) {
      await send("err", name ? m.wsInvalidName : m.wsUsage);
      return;
    }
    if (!removeWorkspace(name)) {
      await send("err", m.wsNotFound(name));
      return;
    }
    await send("ok", m.wsRemoved(name));
    return;
  }

  await send("info", m.wsUsage);
}
