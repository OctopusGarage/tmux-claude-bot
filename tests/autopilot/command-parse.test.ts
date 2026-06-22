import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAutopilotVerb, parseAutopilotVerb } from "../../src/core/autopilot/controls.js";
import { isGlobalKeepAlive } from "../../src/core/autopilot/global-flag.js";
import { AutopilotStore } from "../../src/core/autopilot/state-store.js";
import { messages } from "../../src/core/i18n/index.js";

describe("parseAutopilotVerb", () => {
  it("parses verbs", () => {
    expect(parseAutopilotVerb("")).toEqual({ verb: "status" });
    expect(parseAutopilotVerb("on")).toEqual({ verb: "on", keepAlive: true });
    expect(parseAutopilotVerb("off")).toEqual({ verb: "off" });
    expect(parseAutopilotVerb("keepalive off")).toEqual({ verb: "keepalive", on: false });
    expect(parseAutopilotVerb("stop")).toEqual({ verb: "stop" });
    expect(parseAutopilotVerb("frobnicate")).toEqual({ verb: "unknown", raw: "frobnicate" });
  });

  it("parses goal/confirm/reject verbs", () => {
    expect(parseAutopilotVerb("goal fix-tests")).toEqual({
      verb: "goals",
      ids: ["fix-tests"],
      rounds: 1,
    });
    expect(parseAutopilotVerb("confirm")).toEqual({ verb: "confirm" });
    expect(parseAutopilotVerb("reject")).toEqual({ verb: "reject" });
    expect(parseAutopilotVerb("goal")).toEqual({ verb: "unknown", raw: "goal" });
  });

  it("parses global on/off", () => {
    expect(parseAutopilotVerb("global on")).toEqual({ verb: "global", on: true });
    expect(parseAutopilotVerb("global off")).toEqual({ verb: "global", on: false });
    expect(parseAutopilotVerb("global")).toEqual({ verb: "global", on: true });
  });
});

describe("applyAutopilotVerb", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-verb-"));
    process.env.TCB_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
    delete process.env.AUTOPILOT_GLOBAL_KEEPALIVE;
    rmSync(dir, { recursive: true, force: true });
  });
  it("enables and reports", () => {
    const store = new AutopilotStore();
    const reply = applyAutopilotVerb(store, "s1", "on", messages("telegram"));
    expect(reply).toContain("开");
    expect(store.get("s1").enabled).toBe(true);
  });

  it("off → disables and status shows 关", () => {
    const store = new AutopilotStore();
    store.set("s1", { ...store.get("s1"), enabled: true });
    const reply = applyAutopilotVerb(store, "s1", "off", messages("telegram"));
    expect(reply).toContain("关");
    expect(store.get("s1").enabled).toBe(false);
  });

  it("keepalive off → pureKeepAlive becomes false", () => {
    const store = new AutopilotStore();
    store.set("s1", { ...store.get("s1"), pureKeepAlive: true });
    applyAutopilotVerb(store, "s1", "keepalive off", messages("telegram"));
    expect(store.get("s1").pureKeepAlive).toBe(false);
  });

  it("stop → disables, resets counters, and opts out (global keep-alive won't re-enroll)", () => {
    const store = new AutopilotStore();
    store.set("s1", { ...store.get("s1"), enabled: true, iterations: 5, apiRetries: 3 });
    const reply = applyAutopilotVerb(store, "s1", "stop", messages("telegram"));
    expect(store.get("s1").enabled).toBe(false);
    expect(store.get("s1").iterations).toBe(0);
    expect(store.get("s1").optOut).toBe(true);
    expect(reply).toContain("关");
  });

  it("empty string → returns status without changing enabled", () => {
    const store = new AutopilotStore();
    store.set("s1", { ...store.get("s1"), enabled: true });
    const reply = applyAutopilotVerb(store, "s1", "", messages("telegram"));
    expect(store.get("s1").enabled).toBe(true); // unchanged
    expect(reply).toContain("Autopilot");
  });

  it("unknown verb → returns usage string containing 用法", () => {
    const store = new AutopilotStore();
    const reply = applyAutopilotVerb(store, "s1", "frobnicate", messages("telegram"));
    expect(reply).toContain("用法");
  });

  it("goal fix-tests → sets goalId and enables; reply contains goal id", () => {
    const store = new AutopilotStore();
    const reply = applyAutopilotVerb(store, "s1", "goal fix-tests", messages("telegram"));
    expect(store.get("s1").goalId).toBe("fix-tests");
    expect(store.get("s1").enabled).toBe(true);
    expect(reply).toContain("fix-tests");
  });

  it("goal nope → reply lists available ids; goalId stays undefined", () => {
    const store = new AutopilotStore();
    const reply = applyAutopilotVerb(store, "s1", "goal nope", messages("telegram"));
    expect(reply).toContain("fix-tests");
    expect(store.get("s1").goalId).toBeUndefined();
  });

  it("confirm → sets humanConfirmed true and clears humanGatePending", () => {
    const store = new AutopilotStore();
    store.set("s1", { ...store.get("s1"), humanGatePending: true, humanConfirmed: false });
    applyAutopilotVerb(store, "s1", "confirm", messages("telegram"));
    expect(store.get("s1").humanConfirmed).toBe(true);
    expect(store.get("s1").humanGatePending).toBe(false);
  });

  it("reject → sets humanConfirmed false and clears humanGatePending", () => {
    const store = new AutopilotStore();
    store.set("s1", { ...store.get("s1"), humanGatePending: true, humanConfirmed: true });
    applyAutopilotVerb(store, "s1", "reject", messages("telegram"));
    expect(store.get("s1").humanConfirmed).toBe(false);
    expect(store.get("s1").humanGatePending).toBe(false);
  });

  it("status text for goal-active session contains the goal id", () => {
    const store = new AutopilotStore();
    applyAutopilotVerb(store, "s1", "goal fix-tests", messages("telegram"));
    const reply = applyAutopilotVerb(store, "s1", "", messages("telegram"));
    expect(reply).toContain("fix-tests");
  });

  it("off sets the per-session opt-out (so global keep-alive skips it)", () => {
    const store = new AutopilotStore();
    store.set("s1", { ...store.get("s1"), enabled: true });
    applyAutopilotVerb(store, "s1", "off", messages("telegram"));
    expect(store.get("s1").optOut).toBe(true);
  });

  it("global on/off toggles the persisted global flag", () => {
    const store = new AutopilotStore();
    const reply = applyAutopilotVerb(store, "s1", "global on", messages("telegram"));
    expect(isGlobalKeepAlive()).toBe(true);
    expect(reply.length).toBeGreaterThan(0);
    applyAutopilotVerb(store, "s1", "global off", messages("telegram"));
    expect(isGlobalKeepAlive()).toBe(false);
  });
});
