import { describe, expect, it } from "vitest";
import { replyTargetFromMessage } from "../../../src/core/command/reply-target-from-message.js";

describe("replyTargetFromMessage", () => {
  it("maps a telegram chat message to a target (chatId stringified)", () => {
    expect(replyTargetFromMessage({ chatId: 123, channel: "telegram" })).toEqual({
      channel: "telegram",
      chatId: "123",
    });
  });
  it("maps a lark chat message", () => {
    expect(replyTargetFromMessage({ chatId: "oc_x", channel: "lark" })).toEqual({
      channel: "lark",
      chatId: "oc_x",
    });
  });
  it("returns null for control-socket messages", () => {
    expect(replyTargetFromMessage({ chatId: "control", channel: undefined })).toBeNull();
  });
  it("returns null when channel is absent", () => {
    expect(replyTargetFromMessage({ chatId: 1 })).toBeNull();
  });
});
