import { describe, expect, it } from "vitest";
import {
  getActionPrecondition,
  isMessageAction,
  MESSAGE_ACTIONS,
} from "../../src/core/command/actions.js";

describe("command actions", () => {
  it("exports the canonical message action list and type guard", () => {
    expect(new Set(MESSAGE_ACTIONS).size).toBe(MESSAGE_ACTIONS.length);
    expect(isMessageAction("text")).toBe(true);
    expect(isMessageAction("tab")).toBe(true);
    expect(isMessageAction("bogus")).toBe(false);
  });

  it("classifies action preconditions independently from dispatch execution", () => {
    expect(getActionPrecondition("text")).toBe("running");
    expect(getActionPrecondition("clear")).toBe("running");
    expect(getActionPrecondition("start")).toBe("absent");
    expect(getActionPrecondition("restart")).toBeNull();
    expect(getActionPrecondition("interrupt")).toBeNull();
    expect(getActionPrecondition("status")).toBeNull();
  });
});
