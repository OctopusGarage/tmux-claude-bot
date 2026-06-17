import { describe, expect, it } from "vitest";
import {
  isGroupMgmtCommand,
  isRecoveryCommand,
  parseLarkInput,
} from "../../../src/adapters/lark/commands.js";

describe("parseLarkInput", () => {
  it("plain text → text kind", () => {
    const result = parseLarkInput("hello world");
    expect(result).toEqual({ kind: "text", text: "hello world" });
  });

  it("trims leading/trailing whitespace for plain text", () => {
    const result = parseLarkInput("  hello  ");
    expect(result).toEqual({ kind: "text", text: "hello" });
  });

  it("/help → help kind", () => {
    const result = parseLarkInput("/help");
    expect(result).toEqual({ kind: "help" });
  });

  it("/esc → immediate command", () => {
    const result = parseLarkInput("/esc");
    expect(result).toEqual({ kind: "command", action: "esc", immediate: true });
  });

  it("/interrupt → immediate command", () => {
    const result = parseLarkInput("/interrupt");
    expect(result).toEqual({ kind: "command", action: "interrupt", immediate: true });
  });

  it("/status → immediate command", () => {
    const result = parseLarkInput("/status");
    expect(result).toEqual({ kind: "command", action: "status", immediate: true });
  });

  it("/up → immediate command", () => {
    const result = parseLarkInput("/up");
    expect(result).toEqual({ kind: "command", action: "up", immediate: true });
  });

  it("/down → immediate command", () => {
    const result = parseLarkInput("/down");
    expect(result).toEqual({ kind: "command", action: "down", immediate: true });
  });

  it("/tab → immediate command", () => {
    const result = parseLarkInput("/tab");
    expect(result).toEqual({ kind: "command", action: "tab", immediate: true });
  });

  it("/enter → immediate command", () => {
    const result = parseLarkInput("/enter");
    expect(result).toEqual({ kind: "command", action: "enter", immediate: true });
  });

  it("/clear → immediate command", () => {
    const result = parseLarkInput("/clear");
    expect(result).toEqual({ kind: "command", action: "clear", immediate: true });
  });

  it("/compact → immediate command", () => {
    const result = parseLarkInput("/compact");
    expect(result).toEqual({ kind: "command", action: "compact", immediate: true });
  });

  it("/start → queued command", () => {
    const result = parseLarkInput("/start");
    expect(result).toEqual({ kind: "command", action: "start", immediate: false });
  });

  it("/restart → queued command", () => {
    const result = parseLarkInput("/restart");
    expect(result).toEqual({ kind: "command", action: "restart", immediate: false });
  });

  it("/exit → queued command", () => {
    const result = parseLarkInput("/exit");
    expect(result).toEqual({ kind: "command", action: "exit", immediate: false });
  });

  it("/peek → view peek", () => {
    expect(parseLarkInput("/peek")).toEqual({ kind: "view", name: "peek", arg: undefined });
  });

  it("/list_alive_projects → view listalive", () => {
    expect(parseLarkInput("/list_alive_projects")).toEqual({
      kind: "view",
      name: "listalive",
      arg: undefined,
    });
  });

  it("/list_recent_projects → view recent", () => {
    expect(parseLarkInput("/list_recent_projects")).toEqual({
      kind: "view",
      name: "recent",
      arg: undefined,
    });
  });

  it("/queue_status → view queuestatus", () => {
    expect(parseLarkInput("/queue_status")).toEqual({
      kind: "view",
      name: "queuestatus",
      arg: undefined,
    });
  });

  it("/current_project → view current", () => {
    expect(parseLarkInput("/current_project")).toEqual({
      kind: "view",
      name: "current",
      arg: undefined,
    });
  });

  it("/voice_lang → view voicelang", () => {
    expect(parseLarkInput("/voice_lang")).toEqual({
      kind: "view",
      name: "voicelang",
      arg: undefined,
    });
  });

  it("/doctor → view doctor", () => {
    expect(parseLarkInput("/doctor")).toEqual({ kind: "view", name: "doctor", arg: undefined });
  });

  it("/history → view history, no arg", () => {
    expect(parseLarkInput("/history")).toEqual({ kind: "view", name: "history", arg: undefined });
  });

  it("/history 3 → view history, arg '3'", () => {
    expect(parseLarkInput("/history 3")).toEqual({ kind: "view", name: "history", arg: "3" });
  });

  it("/add_project <path> → view addproject, arg is the path", () => {
    expect(parseLarkInput("/add_project ~/projects/myapp")).toEqual({
      kind: "view",
      name: "addproject",
      arg: "~/projects/myapp",
    });
  });

  it("/add_project with no path → view addproject, arg undefined", () => {
    expect(parseLarkInput("/add_project")).toEqual({
      kind: "view",
      name: "addproject",
      arg: undefined,
    });
  });

  it("/newfreegroup <path> → view newfreegroup, arg is the path", () => {
    expect(parseLarkInput("/newfreegroup ~/projects/app")).toEqual({
      kind: "view",
      name: "newfreegroup",
      arg: "~/projects/app",
    });
    expect(isGroupMgmtCommand("/newfreegroup ~/x")).toBe(true);
  });

  it("/bogus → unknown kind", () => {
    const result = parseLarkInput("/bogus");
    expect(result).toEqual({ kind: "unknown", name: "bogus" });
  });

  it("unknown command with args → unknown kind using first token", () => {
    const result = parseLarkInput("/foo bar baz");
    expect(result).toEqual({ kind: "unknown", name: "foo" });
  });

  it("leading/trailing spaces with command", () => {
    const result = parseLarkInput("  /esc  ");
    expect(result).toEqual({ kind: "command", action: "esc", immediate: true });
  });

  it("case-insensitive: /ESC → immediate esc", () => {
    const result = parseLarkInput("/ESC");
    expect(result).toEqual({ kind: "command", action: "esc", immediate: true });
  });

  it("case-insensitive: /START → queued start", () => {
    const result = parseLarkInput("/START");
    expect(result).toEqual({ kind: "command", action: "start", immediate: false });
  });

  it("case-insensitive: /HELP → help", () => {
    const result = parseLarkInput("/HELP");
    expect(result).toEqual({ kind: "help" });
  });
});

describe("parseLarkInput arg extraction", () => {
  it("extracts the add_project path verbatim, case-insensitively", () => {
    expect(parseLarkInput("/add_project /home/user/app")).toMatchObject({
      kind: "view",
      name: "addproject",
      arg: "/home/user/app",
    });
    // Uppercase command must NOT corrupt the path (was: indexOf(name) === -1 → garbage).
    expect(parseLarkInput("/ADD_PROJECT /home/user/app")).toMatchObject({
      kind: "view",
      name: "addproject",
      arg: "/home/user/app",
    });
  });
});

describe("isRecoveryCommand", () => {
  it("is true for binding-management commands", () => {
    for (const c of [
      "/bind /x",
      "/rebind /x",
      "/restore",
      "/unbind",
      "/newgroup /x",
      "/newfreegroup /x",
    ]) {
      expect(isRecoveryCommand(c)).toBe(true);
    }
  });

  it("is true for /help (so an unbound group can still show its options)", () => {
    expect(isRecoveryCommand("/help")).toBe(true);
  });

  it("is false for plain prompts and non-recovery commands", () => {
    for (const c of ["just chatting", "/status", "/peek", "/list_alive_projects"]) {
      expect(isRecoveryCommand(c)).toBe(false);
    }
  });
});
