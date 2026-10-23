import type { CardActionEvent, LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { scheduleMessages } from "../../core/i18n/scheduled-messages.js";
import { getBinding } from "../../core/projects/group-bindings.js";
import { chatScope } from "../../core/projects/project-manager.js";
import { projectPickerRows } from "../../core/projects/project-session-picker.js";
import { getScheduleDrafts, type ScheduleDraft } from "../../core/scheduled-messages/drafts.js";
import { getScheduledMessageService } from "../../core/scheduled-messages/service.js";
import type { ScheduleOwner } from "../../core/scheduled-messages/types.js";
import { resultCard } from "./cards.js";
import { resolveSession } from "./executor.js";
import { sendCard, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";
import {
  nativeScheduleTime,
  readScheduleForm,
  scheduleComposerCard,
  scheduleFullTextCard,
  scheduleListCard,
  scheduleRecordCard,
  scheduleReviewCard,
} from "./scheduled-message-cards.js";

async function composer(
  channel: LarkChannel,
  deps: HandlerDeps,
  owner: ScheduleOwner,
  draft: ScheduleDraft,
  privateChat: boolean,
): Promise<void> {
  const choices = privateChat
    ? (await projectPickerRows(deps, chatScope("lark", owner.chatId), "project-sessions"))
        .filter((r) => r.alive)
        .map((r) => ({ sid: r.sid, label: r.label }))
    : undefined;
  await sendCard(channel, owner.chatId, scheduleComposerCard(draft, choices));
}
export async function openLarkSchedule(
  channel: LarkChannel,
  deps: HandlerDeps,
  owner: ScheduleOwner,
  privateChat: boolean,
  arg?: string,
  replySession?: string,
): Promise<void> {
  const service = getScheduledMessageService(deps);
  const drafts = getScheduleDrafts();
  const m = scheduleMessages("lark");
  try {
    if (arg === "list") {
      await sendCard(channel, owner.chatId, scheduleListCard(service.list(owner)));
      return;
    }
    const command = /^(show|cancel)\s+(\S+)$/.exec(arg ?? "");
    if (command?.[2]) {
      const record =
        command[1] === "cancel"
          ? service.cancel(command[2], owner)
          : service.get(command[2], owner);
      if (record) await sendCard(channel, owner.chatId, scheduleRecordCard(record));
      else await sendText(channel, owner.chatId, m.notFound);
      return;
    }
    const session = await resolveSession(
      channel,
      deps,
      owner.chatId,
      getBinding(owner.chatId)?.sessionName ?? replySession,
      privateChat,
    );
    if (!session) return;
    let draft = drafts.create(owner, await service.captureTarget(session));
    if (arg) {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(arg);
      if (!match?.[1] || !match[2]) {
        await sendText(channel, owner.chatId, m.usage);
        return;
      }
      draft = drafts.update(owner, draft.id, { text: match[2], when: match[1] });
      await sendCard(channel, owner.chatId, scheduleReviewCard(draft));
      return;
    }
    await composer(channel, deps, owner, draft, privateChat);
  } catch {
    await sendText(channel, owner.chatId, m.invalid);
  }
}
export async function handleLarkScheduleCard(
  channel: LarkChannel,
  deps: HandlerDeps,
  evt: CardActionEvent,
  privateChat: boolean,
): Promise<void> {
  const owner: ScheduleOwner = { channel: "lark", chatId: evt.chatId, userId: evt.operator.openId };
  const value = evt.action.value as {
    cmd: string;
    id?: string;
    revision?: number;
    arg?: string;
    page?: number;
  };
  const service = getScheduledMessageService(deps);
  const drafts = getScheduleDrafts();
  const m = scheduleMessages("lark");
  if (value.cmd === "schedule") {
    await openLarkSchedule(channel, deps, owner, privateChat);
    return;
  }
  if (value.cmd === "schedule_list") {
    await sendCard(channel, evt.chatId, scheduleListCard(service.list(owner), value.page));
    return;
  }
  if (value.cmd === "schedule_body") {
    const record = service.get(value.id ?? "", owner);
    if (record)
      await sendCard(
        channel,
        evt.chatId,
        scheduleFullTextCard(record.text, record.id, value.page, true),
      );
    else await sendText(channel, evt.chatId, m.notFound);
    return;
  }
  if (value.cmd === "schedule_show" || value.cmd === "schedule_cancel") {
    try {
      const record =
        value.cmd === "schedule_cancel"
          ? service.cancel(value.id ?? "", owner)
          : service.get(value.id ?? "", owner);
      if (record) await sendCard(channel, evt.chatId, scheduleRecordCard(record));
      else await sendText(channel, evt.chatId, m.notFound);
    } catch {
      await sendText(channel, evt.chatId, m.invalid);
    }
    return;
  }
  let draft = drafts.get(owner, value.id ?? "");
  if (!draft) {
    await sendText(channel, evt.chatId, m.expired);
    await openLarkSchedule(channel, deps, owner, privateChat);
    return;
  }
  if (value.revision !== draft.revision) {
    await sendText(channel, evt.chatId, m.expired);
    await composer(channel, deps, owner, draft, privateChat);
    return;
  }
  try {
    if (value.cmd === "schedule_full") {
      await sendCard(
        channel,
        evt.chatId,
        scheduleFullTextCard(draft.text, draft.id, value.page, false, draft.revision),
      );
      return;
    }
    if (value.cmd === "schedule_back") {
      await sendCard(channel, evt.chatId, scheduleReviewCard(draft));
      return;
    }
    if (value.cmd === "schedule_discard") {
      drafts.discard(owner, draft.id);
      await sendText(channel, evt.chatId, m.cancelled);
      return;
    }
    if (value.cmd === "schedule_confirm") {
      if (!privateChat && getBinding(owner.chatId)?.sessionName !== draft.target.sessionName)
        throw new Error("Group target changed");
      const record = await drafts.confirm(owner, draft.id, service, value.revision);
      await sendCard(channel, evt.chatId, scheduleRecordCard(record));
      return;
    }
    if (value.cmd === "schedule_edit") {
      await composer(channel, deps, owner, draft, privateChat);
      return;
    }
    const fields = readScheduleForm(evt);
    // Preserve the user's text before validating the other submitted fields.
    if (fields.text !== undefined)
      draft = drafts.update(owner, draft.id, { text: fields.text }, draft.revision);
    if (fields.sid) {
      if (!privateChat) throw new Error("Session selection is private-chat only");
      const rows = await projectPickerRows(
        deps,
        chatScope("lark", owner.chatId),
        "project-sessions",
      );
      const selected = rows.find((r) => r.alive && r.sid === fields.sid);
      if (!selected?.sessionName) throw new Error("Target unavailable");
      draft = drafts.update(
        owner,
        draft.id,
        { target: await service.captureTarget(selected.sessionName) },
        draft.revision,
      );
    }
    const binding = getBinding(owner.chatId);
    if (!privateChat && binding?.sessionName !== draft.target.sessionName)
      throw new Error("Group target changed");
    let when = fields.when ? nativeScheduleTime(fields.when) : undefined;
    if (value.cmd === "schedule_time") {
      if (value.arg === "tomorrow9") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        when = tomorrow.toISOString();
      } else if (["15m", "30m", "1h"].includes(value.arg ?? "")) when = value.arg;
      else throw new Error("Invalid shortcut");
    }
    if (when) draft = drafts.update(owner, draft.id, { when }, draft.revision);
    if (value.cmd === "schedule_review") {
      if (!draft.text.trim() || !draft.dueAt || draft.dueAt <= Date.now())
        throw new Error("Incomplete schedule");
      await sendCard(channel, evt.chatId, scheduleReviewCard(draft));
    } else await composer(channel, deps, owner, draft, privateChat);
  } catch {
    await sendText(channel, evt.chatId, m.invalid);
    const current = drafts.get(owner, draft.id);
    if (current) await composer(channel, deps, owner, current, privateChat);
  }
}
/** Durable completion routing retains only the transport, never the ingress event. */
export function registerLarkScheduleSender(channel: LarkChannel, deps: HandlerDeps): () => void {
  return getScheduledMessageService(deps).registerSender("lark", async (record, event) => {
    if (event.kind === "result") {
      const messageId = await sendCard(
        channel,
        record.owner.chatId,
        resultCard(event.text, record.target.label, Boolean(getBinding(record.owner.chatId))),
      );
      if (messageId) recordReplyTarget(messageId, record.target.sessionName);
    } else
      await sendCard(
        channel,
        record.owner.chatId,
        scheduleRecordCard(event.kind === "sent" ? record : { ...record, error: event.text }),
      );
  });
}
