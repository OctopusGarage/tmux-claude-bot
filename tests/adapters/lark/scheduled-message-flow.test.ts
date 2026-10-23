import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReplyTarget } from "../../../src/adapters/lark/reply-target.js";
import {
  handleLarkScheduleCard,
  registerLarkScheduleSender,
} from "../../../src/adapters/lark/scheduled-messages.js";
import { getScheduleDrafts } from "../../../src/core/scheduled-messages/drafts.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

const target = {
  sessionName: "project-one",
  label: "Project One",
  workspacePath: null,
  incarnation: "one",
};
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  captureTarget: vi.fn(),
  registerSender: vi.fn(),
  binding: undefined as { sessionName: string } | undefined,
}));
vi.mock("../../../src/core/scheduled-messages/service.js", () => ({
  getScheduledMessageService: () => mocks,
}));
vi.mock("../../../src/core/projects/project-session-picker.js", () => ({
  projectPickerRows: async () => [
    { sid: "one", sessionName: "project-one", label: "Project One", alive: true },
  ],
}));
vi.mock("../../../src/core/projects/group-bindings.js", () => ({
  getBinding: () => mocks.binding,
}));
const owner = { channel: "lark" as const, chatId: "chat", userId: "owner" };
function event(
  cmd: string,
  id: string,
  revision: number,
  form?: Record<string, string>,
  userId = "owner",
): CardActionEvent {
  return {
    messageId: "message",
    chatId: "chat",
    operator: { openId: userId },
    action: { tag: "button", value: { cmd, id, revision } },
    raw: { action: { form_value: form } },
  };
}
function prepared() {
  const drafts = getScheduleDrafts();
  let draft = drafts.create(owner, target);
  draft = drafts.update(owner, draft.id, { text: "first\nsecond", when: "30m" });
  return draft;
}
describe("Lark schedule review lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.binding = undefined;
    mocks.captureTarget.mockResolvedValue(target);
    mocks.create.mockImplementation(async (input) => ({
      ...input,
      id: "record",
      target,
      status: "scheduled",
      dueAt: Date.now() + 60000,
      timezone: "UTC",
    }));
  });
  it("submitting the native form only reviews; repeated confirmation schedules once", async () => {
    const channel = fakeChannel(),
      deps = fakeDeps();
    const draft = prepared();
    await handleLarkScheduleCard(
      channel,
      deps,
      event("schedule_review", draft.id, draft.revision, {
        message: "verbatim\n text",
        when: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      true,
    );
    expect(mocks.create).not.toHaveBeenCalled();
    const current = getScheduleDrafts().get(owner, draft.id);
    if (!current) throw new Error("Expected an active draft");
    expect(current.text).toBe("verbatim\n text");
    await handleLarkScheduleCard(
      channel,
      deps,
      event("schedule_confirm", draft.id, current.revision),
      true,
    );
    await handleLarkScheduleCard(
      channel,
      deps,
      event("schedule_confirm", draft.id, current.revision),
      true,
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("preserves entered text after an invalid native time", async () => {
    const draft = prepared();
    await handleLarkScheduleCard(
      fakeChannel(),
      fakeDeps(),
      event("schedule_review", draft.id, draft.revision, {
        message: "keep\nthis",
        when: "not a date",
      }),
      true,
    );
    expect(getScheduleDrafts().get(owner, draft.id)?.text).toBe("keep\nthis");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("refuses another actor and stale reviews", async () => {
    const draft = prepared();
    const channel = fakeChannel();
    const deps = fakeDeps();
    await handleLarkScheduleCard(
      channel,
      deps,
      event("schedule_confirm", draft.id, draft.revision, undefined, "another"),
      true,
    );
    await handleLarkScheduleCard(
      channel,
      deps,
      event("schedule_confirm", draft.id, draft.revision - 1),
      true,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("refuses confirmation if a group was rebound since review", async () => {
    const draft = prepared();
    mocks.binding = { sessionName: "different-project" };
    await handleLarkScheduleCard(
      fakeChannel(),
      fakeDeps(),
      event("schedule_confirm", draft.id, draft.revision),
      false,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("registers completion transport independently of ingress", async () => {
    const channel = fakeChannel();
    registerLarkScheduleSender(channel, fakeDeps({ session: "different-project" }));
    const sender = mocks.registerSender.mock.calls[0]?.[1];
    if (!sender) throw new Error("Expected a registered sender");
    await sender({ owner, target }, { kind: "result", text: "finished" });
    expect(channel.sent[0]?.chatId).toBe("chat");
    expect(resolveReplyTarget("m1")).toBe(target.sessionName);
    expect(JSON.stringify(channel.cards())).toContain("finished");
  });
  it("renders delayed error event details even after successful submission", async () => {
    const channel = fakeChannel();
    registerLarkScheduleSender(channel, fakeDeps());
    const sender = mocks.registerSender.mock.calls[0]?.[1];
    if (!sender) throw new Error("Expected a registered sender");
    await sender(
      {
        id: "record",
        owner,
        target,
        text: "instruction",
        dueAt: Date.now(),
        timezone: "UTC",
        status: "sent",
        sentAt: Date.now(),
      },
      { kind: "error", text: "Completion could not be read" },
    );
    expect(JSON.stringify(channel.cards())).toContain("Completion could not be read");
  });
});
