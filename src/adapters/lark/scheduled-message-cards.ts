import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { resolveUiLang } from "../../core/i18n/index.js";
import { formatScheduledTime, scheduleMessages } from "../../core/i18n/scheduled-messages.js";
import type { ScheduleDraft } from "../../core/scheduled-messages/drafts.js";
import type { ScheduledMessageRecord } from "../../core/scheduled-messages/types.js";
import { signValue } from "./card-signing.js";

const plain = (content: string) => ({ tag: "plain_text", content });
const md = (content: string) => ({ tag: "markdown", content });
const shell = (title: string, elements: object[]) => ({
  schema: "2.0",
  config: { summary: { content: title } },
  header: { title: plain(title) },
  body: { elements },
});
const button = (text: string, value: object, submit = false) => ({
  tag: "button",
  text: plain(text),
  type: "default",
  ...(submit
    ? {
        action_type: "form_submit",
        name: `action_${(value as { cmd: string; arg?: string }).cmd}_${(value as { arg?: string }).arg ?? ""}`,
      }
    : {}),
  behaviors: [{ type: "callback", value: signValue(value) }],
});
const row = (elements: object[]) => ({
  tag: "column_set",
  flex_mode: "flow",
  columns: elements.map((element) => ({ tag: "column", width: "auto", elements: [element] })),
});
type DraftView = Pick<ScheduleDraft, "id" | "revision" | "text" | "target" | "dueAt" | "timezone">;
const preview = (text: string) => (text.length > 1600 ? `${text.slice(0, 1600)}…` : text);
const scheduledTime = (dueAt: number, timezone: string) =>
  `${formatScheduledTime(dueAt, timezone, resolveUiLang("lark"))} (${timezone})`;
export function scheduleComposerCard(
  draft: DraftView,
  choices?: { sid: string; label: string }[],
): object {
  const m = scheduleMessages("lark");
  const value = { id: draft.id, revision: draft.revision };
  const form: object[] = [];
  if (choices?.length)
    form.push({
      tag: "select_static",
      name: "target",
      placeholder: plain(m.chooseTarget),
      options: choices.map((c) => ({ text: plain(c.label), value: c.sid })),
      required: false,
    });
  form.push({
    tag: "input",
    name: "message",
    input_type: "multiline_text",
    label: plain(m.message),
    default_value: draft.text,
    required: false,
    placeholder: plain(m.enterText),
  });
  form.push({
    tag: "picker_datetime",
    name: "when",
    placeholder: plain(m.enterTime),
    required: false,
  });
  form.push(
    row([
      button(m.in15m, { cmd: "schedule_time", ...value, arg: "15m" }, true),
      button(m.in30m, { cmd: "schedule_time", ...value, arg: "30m" }, true),
      button(m.in1h, { cmd: "schedule_time", ...value, arg: "1h" }, true),
      button(m.tomorrow9, { cmd: "schedule_time", ...value, arg: "tomorrow9" }, true),
    ]),
  );
  form.push(button(m.review, { cmd: "schedule_review", ...value }, true));
  return shell(m.title, [
    md(`${m.target}: ${draft.target.label}`),
    ...(draft.dueAt
      ? [md(`${m.time}: ${scheduledTime(draft.dueAt, draft.timezone ?? "UTC")}`)]
      : []),
    { tag: "form", name: "schedule_form", elements: form },
    row([
      button(m.discard, { cmd: "schedule_discard", ...value }),
      button(m.list, { cmd: "schedule_list" }),
    ]),
  ]);
}
export function scheduleReviewCard(draft: DraftView): object {
  const m = scheduleMessages("lark");
  const value = { id: draft.id, revision: draft.revision };
  return shell(m.review, [
    md(
      `${m.target}: ${draft.target.label}\n${m.time}: ${draft.dueAt ? scheduledTime(draft.dueAt, draft.timezone ?? "UTC") : ""}`,
    ),
    { tag: "div", text: plain(preview(draft.text)) },
    md(m.timingNote),
    row([
      button(m.confirm, { cmd: "schedule_confirm", ...value }),
      button(m.fullText, { cmd: "schedule_full", ...value }),
      button(m.editMessage, { cmd: "schedule_edit", ...value }),
      button(m.editTime, { cmd: "schedule_edit", ...value }),
      button(m.back, { cmd: "schedule_edit", ...value }),
      button(m.discard, { cmd: "schedule_discard", ...value }),
    ]),
  ]);
}
export function scheduleRecordCard(record: ScheduledMessageRecord): object {
  const m = scheduleMessages("lark");
  return shell(m.details, [
    md(
      `${m.target}: ${record.target.label}\n${m.time}: ${scheduledTime(record.dueAt, record.timezone)}\n${m.status}: ${m[record.status]}\n${record.id}${record.sentAt ? `\n${m.sent}: ${scheduledTime(record.sentAt, record.timezone)}` : ""}`,
    ),
    { tag: "div", text: plain(preview(record.text)) },
    ...(record.error ? [{ tag: "div", text: plain(preview(record.error)) }] : []),
    md(m.timingNote),
    row([
      button(m.details, { cmd: "schedule_show", id: record.id }),
      ...(["scheduled", "queued", "blocked", "failed", "uncertain"].includes(record.status)
        ? [button(m.cancel, { cmd: "schedule_cancel", id: record.id })]
        : []),
      button(m.list, { cmd: "schedule_list" }),
      button(m.fullText, { cmd: "schedule_body", id: record.id }),
      button(m.create, { cmd: "schedule" }),
    ]),
  ]);
}
export function scheduleListCard(records: ScheduledMessageRecord[], page = 0): object {
  const m = scheduleMessages("lark");
  const start = Math.max(0, page) * 4;
  return shell(m.list, [
    ...(records.length
      ? records
          .slice(start, start + 4)
          .flatMap((r) => [
            md(`${r.target.label} · ${scheduledTime(r.dueAt, r.timezone)} · ${m[r.status]}`),
            button(m.details, { cmd: "schedule_show", id: r.id }),
          ])
      : [md(m.empty)]),
    row([
      ...(start > 0 ? [button(m.back, { cmd: "schedule_list", page: page - 1 })] : []),
      ...(start + 4 < records.length
        ? [button(m.next, { cmd: "schedule_list", page: page + 1 })]
        : []),
      button(m.create, { cmd: "schedule" }),
    ]),
  ]);
}
export function scheduleFullTextCard(
  text: string,
  id: string,
  page = 0,
  record = false,
  revision = 0,
): object {
  const m = scheduleMessages("lark");
  const pageSize = 3400;
  const pages = Math.max(1, Math.ceil(text.length / pageSize));
  page = Math.max(0, Math.min(Math.trunc(page), pages - 1));
  const cmd = record ? "schedule_body" : "schedule_full";
  return shell(`${m.fullText} · ${page + 1}/${pages}`, [
    { tag: "div", text: plain(text.slice(page * pageSize, (page + 1) * pageSize)) },
    row([
      ...(page > 0 ? [button(m.back, { cmd, id, page: page - 1, revision })] : []),
      ...(page + 1 < pages ? [button(m.next, { cmd, id, page: page + 1, revision })] : []),
      button(m.reviewAction, { cmd: record ? "schedule_show" : "schedule_back", id, revision }),
    ]),
  ]);
}
export function readScheduleForm(evt: CardActionEvent): {
  text?: string | undefined;
  when?: string | undefined;
  sid?: string | undefined;
} {
  const raw = evt.raw as { action?: { form_value?: Record<string, unknown> } } | undefined;
  const values = raw?.action?.form_value ?? {};
  return {
    text: typeof values.message === "string" ? values.message : undefined,
    when: typeof values.when === "string" ? values.when : undefined,
    sid: typeof values.target === "string" ? values.target : undefined,
  };
}
/** Native picker values carry a numeric offset. Never infer the sender's zone. */
export function nativeScheduleTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))? ([+-]\d{2})(\d{2})$/.exec(value);
  if (match) return `${match[1]}T${match[2]}:${match[3] ?? "00"}${match[4]}:${match[5]}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return value;
  throw new Error("Invalid date-time picker value");
}
