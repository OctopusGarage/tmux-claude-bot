import { normalizeCardAction } from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import { parseLarkInput } from "../../../src/adapters/lark/commands.js";
import {
  nativeScheduleTime,
  readScheduleForm,
  scheduleComposerCard,
  scheduleFullTextCard,
  scheduleRecordCard,
  scheduleReviewCard,
} from "../../../src/adapters/lark/scheduled-message-cards.js";
import { scheduleMessages } from "../../../src/core/i18n/scheduled-messages.js";

const draft = {
  id: "draft-1",
  revision: 2,
  owner: { channel: "lark" as const, chatId: "chat", userId: "owner" },
  target: {
    sessionName: "project-one",
    label: "Project One",
    workspacePath: null,
    incarnation: "one",
  },
  text: "first\nsecond",
  expiresAt: Date.now() + 60000,
};
const nodes = (value: unknown): Record<string, unknown>[] => {
  if (!value || typeof value !== "object") return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
};
describe("Lark scheduled messages", () => {
  it("renders the wall time in the recorded offset rather than UTC", () => {
    const content = JSON.stringify(
      scheduleReviewCard({ ...draft, dueAt: Date.UTC(2030, 0, 1, 1), timezone: "UTC+08:00" }),
    );
    expect(content).toContain("09:00");
    expect(content).toContain("UTC+08:00");
  });
  it("bounds long previews and pages full content without callback bodies", () => {
    const text = `${"a".repeat(3500)}SECOND_PAGE${"b".repeat(3500)}`;
    const view = { ...draft, text, dueAt: Date.now() + 60000, timezone: "UTC" };
    expect(JSON.stringify(scheduleReviewCard(view)).length).toBeLessThan(6000);
    expect(nodes(scheduleReviewCard(view)).some((n) => n.cmd === "schedule_full")).toBe(true);
    const page = scheduleFullTextCard(text, draft.id, 1, false, draft.revision);
    expect(JSON.stringify(page)).toContain("SECOND_PAGE");
    expect(
      nodes(page)
        .filter((n) => n.cmd)
        .every((n) => !("text" in n)),
    ).toBe(true);
  });
  it("renders failure evidence, identity, actual send time, and terminal cancellation", () => {
    const record = {
      ...draft,
      id: "record-id",
      dueAt: Date.now() + 60000,
      timezone: "UTC",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      requestId: "request",
      status: "blocked" as const,
      error: "Target replaced",
      sentAt: Date.now(),
    };
    const serialized = JSON.stringify(scheduleRecordCard(record));
    expect(serialized).toContain("Target replaced");
    expect(serialized).toContain("record-id");
    expect(serialized).toContain(scheduleMessages("lark").timingNote);
    expect(nodes(scheduleRecordCard(record)).some((n) => n.cmd === "schedule_cancel")).toBe(true);
    for (const status of ["failed", "uncertain"] as const)
      expect(
        nodes(scheduleRecordCard({ ...record, status })).some((n) => n.cmd === "schedule_cancel"),
      ).toBe(true);
    expect(serialized).toContain(scheduleMessages("lark").sent);
  });
  it("uses a native multiline form and date/time picker without an implicit time", () => {
    const card = scheduleComposerCard(draft, [{ sid: "one", label: "Project One" }]);
    const elements = nodes(card);
    expect(elements.find((n) => n.tag === "form")).toBeDefined();
    expect(elements.find((n) => n.tag === "input")).toMatchObject({
      name: "message",
      input_type: "multiline_text",
      default_value: "first\nsecond",
    });
    expect(elements.find((n) => n.tag === "picker_datetime")).toMatchObject({ name: "when" });
    expect(elements.find((n) => n.tag === "picker_datetime")).not.toHaveProperty(
      "initial_datetime",
    );
    expect(elements.some((n) => n.cmd === "schedule_confirm")).toBe(false);
    expect(elements.some((n) => n.cmd === "schedule_review")).toBe(true);
    expect(elements.some((n) => n.tag === "select_static")).toBe(true);
    expect(nodes(scheduleComposerCard(draft)).some((n) => n.tag === "select_static")).toBe(false);
  });
  it("reads actual SDK raw form fields without changing multiline text", () => {
    const event = normalizeCardAction(
      {
        context: { open_message_id: "m", open_chat_id: "chat" },
        operator: { open_id: "owner" },
        action: {
          value: { cmd: "schedule_review" },
          tag: "button",
          form_value: { message: "a\n b", when: "2026-10-24 09:30 +0800", target: "one" },
        },
      } as never,
      { includeRaw: true },
    );
    if (!event) throw new Error("Expected a normalized card callback");
    expect(readScheduleForm(event)).toEqual({
      text: "a\n b",
      when: "2026-10-24 09:30 +0800",
      sid: "one",
    });
  });
  it("normalizes explicit native offsets and rejects zone-less ambiguous timestamps", () => {
    expect(nativeScheduleTime("2026-10-24 09:30 +0800")).toBe("2026-10-24T09:30:00+08:00");
    expect(() => nativeScheduleTime("2026-10-24 09:30")).toThrow();
  });
  it("keeps confirmation out of the composer and in the review", () => {
    expect(
      nodes(
        scheduleReviewCard({ ...draft, dueAt: Date.now() + 60000, timezone: "Asia/Singapore" }),
      ).some((n) => n.cmd === "schedule_confirm"),
    ).toBe(true);
  });
  it("recognizes typed scheduling instead of forwarding it as user text", () => {
    expect(parseLarkInput("/schedule 30m line one\nline two")).toEqual({
      kind: "view",
      name: "schedule",
      arg: "30m line one\nline two",
    });
  });
});
