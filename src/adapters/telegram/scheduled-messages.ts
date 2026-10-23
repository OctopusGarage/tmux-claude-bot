import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { scheduledMessageCatalogs } from "../../core/i18n/catalog/scheduled-messages.js";
import { resolveUiLang } from "../../core/i18n/index.js";
import { formatScheduledTime, scheduleMessages } from "../../core/i18n/scheduled-messages.js";
import { resolveTargetSession } from "../../core/projects/operator.js";
import { projectPickerRows } from "../../core/projects/project-session-picker.js";
import { getScheduleDrafts } from "../../core/scheduled-messages/drafts.js";
import { getScheduledMessageService } from "../../core/scheduled-messages/service.js";
import { parseScheduleTime } from "../../core/scheduled-messages/time.js";
import type { ScheduledMessageRecord, ScheduleOwner } from "../../core/scheduled-messages/types.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { safeAnswerCallback } from "./callback-utils.js";
import { buildControlKeyboard } from "./keyboards.js";
import { MSG } from "./messages.js";
import { resolveAliveSessionByShortId } from "./project-ops.js";
import { reply, send } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { tgScope } from "./scope.js";
import { resolveSessionFromReply } from "./session.js";

type Draft = NonNullable<ReturnType<ReturnType<typeof getScheduleDrafts>["get"]>>;
const copy = () => scheduleMessages("telegram");
const drafts = () => getScheduleDrafts();
const service = (deps: HandlerDeps) => getScheduledMessageService(deps);
const PAGE_SIZE = 6;
// Keep bounded tombstones so a late reply to an expired/discarded draft cannot
// unexpectedly become immediate agent input.
const dedicatedPrompts = new Map<string, number>();
function promptKey(owner: ScheduleOwner, id: string): string {
  return `${owner.channel}:${owner.chatId}:${owner.userId}:${id}`;
}

export function scheduleCallbackData(action: string, id = "_", revision = 0, value = ""): string {
  const data = ["sm", action, id, revision.toString(36), value].filter(Boolean).join(":");
  if (Buffer.byteLength(data, "utf8") > 64) throw new Error("Schedule callback exceeds 64 bytes");
  return data;
}

/** Calendar values are local dates; numeric overflow naturally crosses years. */
export function scheduleCalendarDays(year: number, month: number): string[] {
  const start = new Date(year, month, 1);
  const count = new Date(year, month + 1, 0).getDate();
  const prefix = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, "0")}`);
}

function ownerOf(ctx: Context): ScheduleOwner | undefined {
  if (ctx.chat?.id === undefined || ctx.from?.id === undefined) return undefined;
  return { channel: "telegram", chatId: String(ctx.chat.id), userId: String(ctx.from.id) };
}

export function scheduleEntryKeyboard(sid?: string): InlineKeyboard {
  const m = copy();
  return new InlineKeyboard()
    .text(m.create, scheduleCallbackData("new", sid))
    .text(m.list, scheduleCallbackData("list"));
}

function dateLabel(timestamp: number, timezone: string): string {
  return formatScheduledTime(timestamp, timezone, resolveUiLang("telegram"));
}

function summary(
  item: Pick<ScheduledMessageRecord, "target" | "text" | "dueAt" | "timezone">,
): string {
  const m = copy();
  const preview = item.text.length > 1600 ? `${item.text.slice(0, 1600)}…` : item.text;
  return `${m.target}: ${item.target.label}\n${m.time}: ${dateLabel(item.dueAt, item.timezone)}\n${m.timezone}: ${item.timezone}\n\n${m.content}:\n${preview}`;
}

async function expired(ctx: Context, targets: ReplyTargetMap): Promise<void> {
  await reply(ctx, "info", copy().expired, {
    replyTarget: targets,
    replyMarkup: scheduleEntryKeyboard(),
  });
}

async function promptField(
  ctx: Context,
  draft: Draft,
  kind: "text" | "time",
  targets: ReplyTargetMap,
): Promise<void> {
  const id = await reply(ctx, "info", kind === "text" ? copy().enterText : copy().enterTime, {
    session: draft.target.sessionName,
    replyTarget: targets,
    // Selective ForceReply needs a user message to reply to. Button callbacks
    // have no ctx.message; owner-scoped draft lookup still guards their replies.
    replyMarkup: { force_reply: true, selective: ctx.message !== undefined },
  });
  if (id !== null) {
    drafts().bindPrompt(draft.owner, draft.id, String(id), kind);
    dedicatedPrompts.set(promptKey(draft.owner, String(id)), Date.now());
    while (dedicatedPrompts.size > 10_000) {
      const oldest = dedicatedPrompts.keys().next().value;
      if (oldest === undefined) break;
      dedicatedPrompts.delete(oldest);
    }
  }
}

async function showReview(ctx: Context, draft: Draft, targets: ReplyTargetMap): Promise<void> {
  if (!draft.text) return promptField(ctx, draft, "text", targets);
  if (!draft.dueAt || !draft.timezone) return showTimes(ctx, draft, targets);
  const m = copy();
  const kb = new InlineKeyboard()
    .text(m.confirm, scheduleCallbackData("confirm", draft.id, draft.revision))
    .text(m.fullText, scheduleCallbackData("full", draft.id, draft.revision))
    .row()
    .text(m.editTime, scheduleCallbackData("time", draft.id, draft.revision))
    .text(m.editMessage, scheduleCallbackData("text", draft.id, draft.revision))
    .row()
    .text(m.chooseTarget, scheduleCallbackData("targets", draft.id, draft.revision))
    .text(m.discard, scheduleCallbackData("discard", draft.id, draft.revision));
  await reply(ctx, "view", m.title, {
    body: `${summary({ ...draft, dueAt: draft.dueAt, timezone: draft.timezone })}\n\n${m.timingNote}`,
    replyTarget: targets,
    replyMarkup: kb,
  });
}

async function showTimes(ctx: Context, draft: Draft, targets: ReplyTargetMap): Promise<void> {
  const m = copy();
  const kb = new InlineKeyboard()
    .text(m.in15m, scheduleCallbackData("at", draft.id, draft.revision, "15m"))
    .text(m.in30m, scheduleCallbackData("at", draft.id, draft.revision, "30m"))
    .row()
    .text(m.in1h, scheduleCallbackData("at", draft.id, draft.revision, "1h"))
    .text(m.tomorrow9, scheduleCallbackData("at", draft.id, draft.revision, "tomorrow"))
    .row()
    .text(m.custom, scheduleCallbackData("calendar", draft.id, draft.revision))
    .text(m.customInput, scheduleCallbackData("typed", draft.id, draft.revision))
    .row()
    .text(m.back, scheduleCallbackData("review", draft.id, draft.revision))
    .text(m.discard, scheduleCallbackData("discard", draft.id, draft.revision));
  await reply(ctx, "view", m.time, { replyTarget: targets, replyMarkup: kb });
}

async function showCalendar(
  ctx: Context,
  draft: Draft,
  value: string,
  targets: ReplyTargetMap,
): Promise<void> {
  const now = new Date();
  const [year, month] = value
    ? value.split("-").map(Number)
    : [now.getFullYear(), now.getMonth() + 1];
  if (
    !year ||
    !month ||
    month < 1 ||
    month > 12 ||
    year < now.getFullYear() ||
    year > now.getFullYear() + 5
  )
    return expired(ctx, targets);
  const days = scheduleCalendarDays(year, month - 1);
  const kb = new InlineKeyboard();
  const firstDay = new Date(year, month - 1, 1).getDay();
  for (let i = 0; i < firstDay; i++) kb.text("·", "noop");
  days.forEach((day, i) => {
    kb.text(String(i + 1), scheduleCallbackData("date", draft.id, draft.revision, day));
    if ((i + firstDay + 1) % 7 === 0) kb.row();
  });
  kb.row();
  const previous = new Date(year, month - 2, 1);
  const next = new Date(year, month, 1);
  for (const [label, date] of [
    [copy().back, previous],
    [copy().next, next],
  ] as const) {
    kb.text(
      label,
      scheduleCallbackData(
        "calendar",
        draft.id,
        draft.revision,
        `${date.getFullYear()}-${date.getMonth() + 1}`,
      ),
    );
  }
  kb.row().text(copy().editTime, scheduleCallbackData("time", draft.id, draft.revision));
  await reply(ctx, "view", `${copy().pickDate} · ${year}-${String(month).padStart(2, "0")}`, {
    replyTarget: targets,
    replyMarkup: kb,
  });
}

// Date/hour selections are adapter-only presentation state. Shared drafts own all
// user content, pinned targets, revisions, ownership, expiry and confirmation.
const dateSelections = new Map<
  string,
  { revision: number; date: string; hour?: number; expiresAt: number }
>();
function pruneDateSelections(): void {
  for (const [id, value] of dateSelections)
    if (value.expiresAt < Date.now()) dateSelections.delete(id);
}

async function showHours(
  ctx: Context,
  draft: Draft,
  date: string,
  targets: ReplyTargetMap,
): Promise<void> {
  pruneDateSelections();
  draft = drafts().update(draft.owner, draft.id, {}, draft.revision);
  dateSelections.set(draft.id, {
    revision: draft.revision,
    date,
    expiresAt: Date.now() + 30 * 60_000,
  });
  const kb = new InlineKeyboard();
  for (let h = 0; h < 24; h++) {
    kb.text(
      String(h).padStart(2, "0"),
      scheduleCallbackData("hour", draft.id, draft.revision, String(h)),
    );
    if ((h + 1) % 6 === 0) kb.row();
  }
  kb.text(
    copy().back,
    scheduleCallbackData("calendar", draft.id, draft.revision, date.slice(0, 7)),
  );
  await reply(ctx, "view", `${copy().pickHour} · ${date}`, {
    replyTarget: targets,
    replyMarkup: kb,
  });
}

async function showMinutes(
  ctx: Context,
  draft: Draft,
  hour: number,
  targets: ReplyTargetMap,
): Promise<void> {
  const selected = dateSelections.get(draft.id);
  if (
    !selected ||
    selected.revision !== draft.revision ||
    selected.expiresAt < Date.now() ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23
  )
    return expired(ctx, targets);
  draft = drafts().update(draft.owner, draft.id, {}, draft.revision);
  selected.revision = draft.revision;
  selected.hour = hour;
  const kb = new InlineKeyboard();
  for (let minute = 0; minute < 60; minute++) {
    kb.text(
      String(minute).padStart(2, "0"),
      scheduleCallbackData("minute", draft.id, draft.revision, String(minute)),
    );
    if ((minute + 1) % 10 === 0) kb.row();
  }
  kb.text(copy().back, scheduleCallbackData("date", draft.id, draft.revision, selected.date));
  await reply(
    ctx,
    "view",
    `${copy().pickMinute} · ${selected.date} ${String(hour).padStart(2, "0")}`,
    { replyTarget: targets, replyMarkup: kb },
  );
}

async function showTargets(
  ctx: Context,
  draft: Draft,
  deps: HandlerDeps,
  targets: ReplyTargetMap,
): Promise<void> {
  if (ctx.chat?.type !== "private") return showReview(ctx, draft, targets);
  const rows = await projectPickerRows(deps, tgScope(ctx), "project-sessions");
  const kb = new InlineKeyboard();
  for (const row of rows.filter((r) => r.alive))
    kb.text(row.label, scheduleCallbackData("target", draft.id, draft.revision, row.sid)).row();
  kb.text(copy().back, scheduleCallbackData("review", draft.id, draft.revision));
  await reply(ctx, "view", copy().selectTarget, { replyTarget: targets, replyMarkup: kb });
}

async function createDraft(
  ctx: Context,
  deps: HandlerDeps,
  targets: ReplyTargetMap,
  sid?: string,
): Promise<void> {
  const owner = ownerOf(ctx);
  if (!owner) return;
  const pinned =
    sid && sid !== "_" && ctx.chat?.type === "private"
      ? await resolveAliveSessionByShortId(deps, sid)
      : null;
  if (sid && sid !== "_" && ctx.chat?.type === "private" && !pinned) {
    await reply(ctx, "err", copy().invalidTarget, {
      replyTarget: targets,
      replyMarkup: scheduleEntryKeyboard(),
    });
    return;
  }
  const resolved = pinned ?? (await resolveSessionFromReply(ctx, targets, deps));
  const session = resolveTargetSession(
    resolved,
    deps.config.homeOperator.enabled && ctx.chat?.type === "private",
    deps.config.projectSessionPrefix,
  );
  if (!session) {
    await reply(ctx, "err", MSG.noSession, { replyTarget: targets });
    return;
  }
  try {
    const target = await service(deps).captureTarget(session);
    const draft = drafts().create(owner, target);
    await promptField(ctx, draft, "text", targets);
    // Target changes are draft-local and never write currentProject.
    await reply(ctx, "info", `${copy().target}: ${target.label}`, {
      replyTarget: targets,
      replyMarkup: new InlineKeyboard()
        .text(copy().chooseTarget, scheduleCallbackData("targets", draft.id, draft.revision))
        .text(copy().discard, scheduleCallbackData("discard", draft.id, draft.revision)),
    });
  } catch {
    await reply(ctx, "err", copy().invalidTarget, { replyTarget: targets });
  }
}

async function showRecord(
  ctx: Context,
  record: ScheduledMessageRecord | undefined,
  targets: ReplyTargetMap,
  created = false,
): Promise<void> {
  if (!record) {
    await reply(ctx, "info", copy().notFound, {
      replyTarget: targets,
      replyMarkup: scheduleEntryKeyboard(),
    });
    return;
  }
  const m = copy();
  const status = m[record.status];
  const kb = new InlineKeyboard()
    .text(m.details, scheduleCallbackData("show", record.id))
    .text(m.fullText, scheduleCallbackData("body", record.id))
    .row();
  if (["scheduled", "queued", "blocked", "failed", "uncertain"].includes(record.status))
    kb.text(m.cancel, scheduleCallbackData("cancel", record.id));
  kb.text(m.list, scheduleCallbackData("list"));
  await reply(ctx, "view", created ? m.created : m.details, {
    body: `${summary(record)}\n\n${m.status}: ${status}\n${record.id}${record.sentAt ? `\n${m.sent}: ${dateLabel(record.sentAt, record.timezone)}` : ""}${record.error ? `\n${record.error}` : ""}${created ? `\n\n${m.timingNote}` : ""}`,
    replyTarget: targets,
    replyMarkup: kb,
  });
}

async function showList(
  ctx: Context,
  deps: HandlerDeps,
  owner: ScheduleOwner,
  targets: ReplyTargetMap,
  page = 0,
): Promise<void> {
  const items = service(deps).list(owner);
  const m = copy();
  const offset =
    Math.max(0, Math.min(page, Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1))) * PAGE_SIZE;
  const kb = new InlineKeyboard();
  for (const record of items.slice(offset, offset + PAGE_SIZE))
    kb.text(
      `${record.target.label} · ${dateLabel(record.dueAt, record.timezone)} · ${m[record.status]}`,
      scheduleCallbackData("show", record.id),
    ).row();
  if (offset > 0) kb.text(m.back, scheduleCallbackData("list", "_", 0, String(page - 1)));
  if (offset + PAGE_SIZE < items.length)
    kb.text(m.next, scheduleCallbackData("list", "_", 0, String(page + 1)));
  kb.row().text(m.create, scheduleCallbackData("new"));
  await reply(ctx, "list", items.length ? m.list : m.empty, {
    replyTarget: targets,
    replyMarkup: kb,
  });
}

async function showFullText(
  ctx: Context,
  text: string,
  id: string,
  revision: number,
  targets: ReplyTargetMap,
  page = 0,
  record = false,
): Promise<void> {
  const chunkSize = 3400;
  const pages = Math.max(1, Math.ceil(text.length / chunkSize));
  page = Math.max(0, Math.min(page, pages - 1));
  const kb = new InlineKeyboard();
  const action = record ? "body" : "full";
  if (page > 0) kb.text(copy().back, scheduleCallbackData(action, id, revision, String(page - 1)));
  if (page + 1 < pages)
    kb.text(copy().next, scheduleCallbackData(action, id, revision, String(page + 1)));
  kb.row().text(
    copy().reviewAction,
    scheduleCallbackData(record ? "show" : "review", id, revision),
  );
  await reply(ctx, "view", `${copy().fullText} · ${page + 1}/${pages}`, {
    body: text.slice(page * chunkSize, (page + 1) * chunkSize),
    replyTarget: targets,
    replyMarkup: kb,
  });
}

export async function handleScheduleCommand(
  ctx: Context,
  deps: HandlerDeps,
  targets: ReplyTargetMap,
): Promise<void> {
  const owner = ownerOf(ctx);
  if (!owner) return;
  const raw = (ctx.message?.text ?? "").replace(/^\S+\s*/, "");
  if (!raw) return createDraft(ctx, deps, targets);
  const match = /^(\S+)(?:[ \t]+|\n)?([\s\S]*)$/.exec(raw);
  const action = match?.[1] ?? "";
  const rest = match?.[2] ?? "";
  try {
    if (action === "list") return showList(ctx, deps, owner, targets);
    if (action === "show") return showRecord(ctx, service(deps).get(rest.trim(), owner), targets);
    if (action === "cancel")
      return showRecord(ctx, service(deps).cancel(rest.trim(), owner), targets);
    if (!rest.trim() || rest.length > deps.config.maxInboundLength)
      throw new Error("Invalid content");
    const resolved = await resolveSessionFromReply(ctx, targets, deps);
    const session = resolveTargetSession(
      resolved,
      deps.config.homeOperator.enabled && ctx.chat?.type === "private",
      deps.config.projectSessionPrefix,
    );
    if (!session) {
      await reply(ctx, "err", MSG.noSession, { replyTarget: targets });
      return;
    }
    const record = await service(deps).create({
      owner,
      sessionName: session,
      text: rest,
      when: parseScheduleTime(action),
      requestId: `telegram:${owner.chatId}:${owner.userId}:${ctx.message?.message_id}`,
    });
    await showRecord(ctx, record, targets, true);
  } catch {
    await reply(ctx, "err", copy().invalid, {
      body: copy().usage,
      replyTarget: targets,
      replyMarkup: scheduleEntryKeyboard(),
    });
  }
}

/** Recognize bot-origin prompts even after ephemeral draft state is lost. */
function isEarlierSchedulePrompt(ctx: Context): boolean {
  const original = ctx.message?.reply_to_message;
  if (!original?.from?.is_bot || original.from.id !== ctx.me.id || !original.text) return false;
  const firstLine = original.text.split("\n", 1)[0];
  return Object.values(scheduledMessageCatalogs).some(
    (catalog) => firstLine === catalog.enterText || firstLine === catalog.enterTime,
  );
}

/** Only replies to a dedicated, owner-scoped prompt are consumed. */
export async function handleScheduleReply(ctx: Context, targets: ReplyTargetMap): Promise<boolean> {
  const owner = ownerOf(ctx);
  const promptId = ctx.message?.reply_to_message?.message_id;
  if (!owner || promptId === undefined) return false;
  const found = drafts().findPrompt(owner, String(promptId));
  if (!found) {
    if (!dedicatedPrompts.has(promptKey(owner, String(promptId))) && !isEarlierSchedulePrompt(ctx))
      return false;
    await expired(ctx, targets);
    return true;
  }
  const text = ctx.message?.text ?? "";
  try {
    if (!text.trim()) throw new Error("Empty content");
    const draft = drafts().update(
      owner,
      found.draft.id,
      found.kind === "text" ? { text } : { when: parseScheduleTime(text.trim()) },
      found.draft.revision,
    );
    await showReview(ctx, draft, targets);
  } catch {
    await reply(ctx, "err", copy().invalid, { replyTarget: targets });
    await promptField(ctx, found.draft, found.kind, targets);
  }
  return true;
}

export async function handleScheduleCallback(
  ctx: Context,
  deps: HandlerDeps,
  targets: ReplyTargetMap,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("sm:")) return false;
  await safeAnswerCallback(ctx);
  const owner = ownerOf(ctx);
  if (!owner) return true;
  const [, action, id = "_", revisionText = "0", value = ""] = data.split(":");
  const revision = parseInt(revisionText, 36);
  try {
    if (action === "new") {
      await createDraft(ctx, deps, targets, id);
      return true;
    }
    if (action === "list") {
      await showList(ctx, deps, owner, targets, Number(value) || 0);
      return true;
    }
    if (action === "show") {
      await showRecord(ctx, service(deps).get(id, owner), targets);
      return true;
    }
    if (action === "cancel") {
      await showRecord(ctx, service(deps).cancel(id, owner), targets);
      return true;
    }
    if (action === "body") {
      const record = service(deps).get(id, owner);
      if (record) await showFullText(ctx, record.text, id, 0, targets, Number(value) || 0, true);
      else await showRecord(ctx, undefined, targets);
      return true;
    }
    if (action === "confirm") {
      await showRecord(
        ctx,
        await drafts().confirm(owner, id, service(deps), revision),
        targets,
        true,
      );
      return true;
    }
    const draft = drafts().get(owner, id);
    if (!draft || draft.revision !== revision) {
      await expired(ctx, targets);
      return true;
    }
    if (action === "discard") {
      drafts().discard(owner, id);
      dateSelections.delete(id);
      await reply(ctx, "info", copy().cancelled, {
        replyTarget: targets,
        replyMarkup: scheduleEntryKeyboard(),
      });
    } else if (action === "text") await promptField(ctx, draft, "text", targets);
    else if (action === "typed") await promptField(ctx, draft, "time", targets);
    else if (action === "time") await showTimes(ctx, draft, targets);
    else if (action === "review") await showReview(ctx, draft, targets);
    else if (action === "full")
      await showFullText(ctx, draft.text, draft.id, draft.revision, targets, Number(value) || 0);
    else if (action === "targets") await showTargets(ctx, draft, deps, targets);
    else if (action === "target") {
      if (ctx.chat?.type !== "private") {
        await expired(ctx, targets);
        return true;
      }
      const session = await resolveAliveSessionByShortId(deps, value);
      if (!session) throw new Error("Target unavailable");
      const updated = drafts().update(
        owner,
        id,
        { target: await service(deps).captureTarget(session) },
        revision,
      );
      await showReview(ctx, updated, targets);
    } else if (action === "calendar") await showCalendar(ctx, draft, value, targets);
    else if (action === "date" && /^\d{4}-\d{2}-\d{2}$/.test(value))
      await showHours(ctx, draft, value, targets);
    else if (action === "hour") await showMinutes(ctx, draft, Number(value), targets);
    else if (action === "at" || action === "minute") {
      let expression = value;
      if (action === "minute") {
        const selected = dateSelections.get(id);
        const minute = Number(value);
        if (
          !selected ||
          selected.revision !== revision ||
          selected.hour === undefined ||
          selected.expiresAt < Date.now() ||
          !Number.isInteger(minute) ||
          minute < 0 ||
          minute > 59
        )
          throw new Error("Invalid time");
        expression = `${selected.date}T${String(selected.hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        expression = localTimeWithOffset(expression);
      } else if (value === "tomorrow") {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        expression = tomorrow.toISOString();
      }
      const when = parseScheduleTime(expression);
      if (action === "minute" || value === "tomorrow")
        when.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const updated = drafts().update(owner, id, { when }, revision);
      dateSelections.delete(id);
      await showReview(ctx, updated, targets);
    } else await expired(ctx, targets);
  } catch {
    await expired(ctx, targets);
  }
  return true;
}

/** Reject nonexistent and repeated DST wall times instead of silently shifting. */
function localTimeWithOffset(expression: string): string {
  const date = new Date(expression);
  const [datePart, timePart] = expression.split("T");
  const actualDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const actualTime = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (actualDate !== datePart || actualTime !== timePart) throw new Error("Invalid local date");
  for (const delta of [-120, -60, -30, 30, 60, 120]) {
    const other = new Date(date.getTime() + delta * 60_000);
    if (
      other.getFullYear() === date.getFullYear() &&
      other.getMonth() === date.getMonth() &&
      other.getDate() === date.getDate() &&
      other.getHours() === date.getHours() &&
      other.getMinutes() === date.getMinutes()
    )
      throw new Error("Ambiguous local date");
  }
  return date.toISOString();
}

/** Register a transport, never a request Context, for delayed receipts/results. */
export function registerScheduledTelegramSender(
  bot: Bot,
  deps: HandlerDeps,
  targets: ReplyTargetMap,
): () => void {
  return service(deps).registerSender("telegram", async (record, event) => {
    const m = copy();
    const head =
      event.kind === "result" ? m.title : event.kind === "error" ? m.failed : m[event.kind];
    await send(
      bot,
      Number(record.owner.chatId),
      event.kind === "result" ? "result" : event.kind === "sent" ? "ok" : "warn",
      head,
      {
        session: record.target.sessionName,
        body: event.text,
        markdown: event.kind === "result",
        replyTarget: targets,
        replyMarkup: buildControlKeyboard(sessionShortId(record.target.sessionName)),
      },
    );
  });
}
