import { describe, expect, it } from "vitest";
import {
  buildControlKeyboard,
  buildExpandedControlKeyboard,
  buildProjectDeleteKeyboard,
  buildProjectKeyboard,
  buildRecentKeyboard,
  encodeControlAction,
  parseCallbackData,
} from "../src/adapters/telegram/keyboards.js";

function callbackDatas(kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) {
  return kb.inline_keyboard.flat().map((b) => b.callback_data);
}

describe("parseCallbackData", () => {
  it("parses a control action", () => {
    expect(parseCallbackData("a:esc:abc123")).toEqual({
      kind: "act",
      action: "esc",
      sid: "abc123",
    });
  });

  it("parses a switch action", () => {
    expect(parseCallbackData("s:abc123")).toEqual({ kind: "switch", sid: "abc123" });
  });

  it("parses a remove action", () => {
    expect(parseCallbackData("r:abc123")).toEqual({ kind: "remove", sid: "abc123" });
  });

  it("parses the more/less keyboard-toggle actions", () => {
    expect(parseCallbackData("m:abc123")).toEqual({ kind: "more", sid: "abc123" });
    expect(parseCallbackData("l:abc123")).toEqual({ kind: "less", sid: "abc123" });
  });

  it("parses the project delete-mode toggles (no sid)", () => {
    expect(parseCallbackData("dm")).toEqual({ kind: "delmode" });
    expect(parseCallbackData("dl")).toEqual({ kind: "dellist" });
  });

  it("parses the recent-project add action", () => {
    expect(parseCallbackData("g:abc123")).toEqual({ kind: "add", sid: "abc123" });
  });

  it("parses the view actions (peek/history need a sid; list/queue don't)", () => {
    expect(parseCallbackData("pk:abc123")).toEqual({ kind: "peek", sid: "abc123" });
    expect(parseCallbackData("hi:abc123")).toEqual({ kind: "history", sid: "abc123" });
    expect(parseCallbackData("la")).toEqual({ kind: "listalive" });
    expect(parseCallbackData("qs")).toEqual({ kind: "queuestatus" });
  });

  it("returns null for unknown / malformed data", () => {
    expect(parseCallbackData("")).toBeNull();
    expect(parseCallbackData("garbage")).toBeNull();
    expect(parseCallbackData("a:esc")).toBeNull();
    expect(parseCallbackData("m:")).toBeNull();
  });

  it("rejects a control action whose verb is not an allowed MessageAction", () => {
    expect(parseCallbackData("a:rm -rf:abc123")).toBeNull();
  });
});

describe("encodeControlAction <-> parseCallbackData round-trip", () => {
  it("round-trips every encoded control action", () => {
    for (const action of ["esc", "interrupt", "enter", "restart"]) {
      const data = encodeControlAction(action, "abc123");
      expect(parseCallbackData(data)).toEqual({ kind: "act", action, sid: "abc123" });
    }
  });

  it("keeps callback_data within Telegram's 64-byte limit", () => {
    const data = encodeControlAction("interrupt", "abcdef");
    expect(Buffer.byteLength(data, "utf-8")).toBeLessThanOrEqual(64);
  });
});

describe("buildControlKeyboard", () => {
  it("collapsed shows esc/clear/compact/peek/history/list/queue plus a 'more' toggle", () => {
    const kb = buildControlKeyboard("abc123") as unknown as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const datas = callbackDatas(kb);
    expect(datas).toContain("a:esc:abc123");
    expect(datas).toContain("a:clear:abc123");
    expect(datas).toContain("a:compact:abc123");
    expect(datas).toContain("pk:abc123"); // peek
    expect(datas).toContain("hi:abc123"); // history
    expect(datas).toContain("la"); // list alive projects
    expect(datas).toContain("qs"); // queue status
    expect(datas).toContain("m:abc123"); // expand toggle
    // /new is gone; other tmux control keys stay in the expanded view
    expect(datas).not.toContain("a:new:abc123");
    expect(datas).not.toContain("a:enter:abc123");
    expect(datas).not.toContain("a:interrupt:abc123");
    expect(datas).not.toContain("a:restart:abc123");
  });
});

describe("buildExpandedControlKeyboard", () => {
  it("adds the secondary controls and a 'collapse' toggle", () => {
    const kb = buildExpandedControlKeyboard("abc123") as unknown as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const datas = callbackDatas(kb);
    // primary still present
    expect(datas).toContain("a:enter:abc123");
    // secondary controls
    expect(datas).toContain("a:clear:abc123");
    expect(datas).toContain("a:compact:abc123");
    expect(datas).toContain("a:up:abc123");
    expect(datas).toContain("a:down:abc123");
    expect(datas).toContain("a:exit:abc123");
    // view actions
    expect(datas).toContain("pk:abc123"); // peek
    expect(datas).toContain("hi:abc123"); // history
    expect(datas).toContain("la"); // list alive projects
    expect(datas).toContain("qs"); // queue status
    expect(datas).toContain("l:abc123"); // collapse toggle
    expect(datas).not.toContain("m:abc123"); // no expand toggle when already expanded
  });
});

function rows(kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) {
  return kb.inline_keyboard;
}

describe("buildProjectKeyboard", () => {
  it("renders one full-width switch row per project plus a delete-mode toggle", () => {
    const kb = buildProjectKeyboard([
      { sid: "aaaaaa", label: "proj-a", active: false },
      { sid: "bbbbbb", label: "proj-b", active: true },
    ]) as unknown as { inline_keyboard: { text: string; callback_data?: string }[][] };
    const datas = callbackDatas(kb);
    // each project is its own full-width row (one button per row)
    for (const r of rows(kb)) expect(r.length).toBe(1);
    expect(datas).toContain("s:aaaaaa"); // inactive → switch
    expect(datas).not.toContain("s:bbbbbb"); // active → not switchable
    expect(datas).not.toContain("r:aaaaaa"); // no inline delete in normal mode
    expect(datas).toContain("dm"); // delete-mode toggle
  });
});

describe("buildRecentKeyboard", () => {
  it("renders switch for alive projects, add for not-running, and marks the active one", () => {
    const kb = buildRecentKeyboard([
      { sid: "aaaaaa", label: "alive-proj", alive: true, active: false },
      { sid: "bbbbbb", label: "active-proj", alive: true, active: true },
      { sid: "cccccc", label: "dead-proj", alive: false, active: false },
    ]) as unknown as { inline_keyboard: { text: string; callback_data?: string }[][] };
    const datas = callbackDatas(kb);
    for (const r of kb.inline_keyboard) expect(r.length).toBe(1); // full-width rows
    expect(datas).toContain("s:aaaaaa"); // alive → switch
    expect(datas).not.toContain("s:bbbbbb"); // active → inert
    expect(datas).toContain("g:cccccc"); // dead → add/create
    expect(datas).not.toContain("s:cccccc");
  });
});

describe("buildProjectDeleteKeyboard", () => {
  it("renders one full-width delete row per project plus a cancel toggle", () => {
    const kb = buildProjectDeleteKeyboard([
      { sid: "aaaaaa", label: "proj-a", active: false },
      { sid: "bbbbbb", label: "proj-b", active: true },
    ]) as unknown as { inline_keyboard: { text: string; callback_data?: string }[][] };
    const datas = callbackDatas(kb);
    for (const r of rows(kb)) expect(r.length).toBe(1);
    expect(datas).toContain("r:aaaaaa");
    expect(datas).toContain("r:bbbbbb"); // active can be deleted too
    expect(datas).toContain("dl"); // back to list
    expect(datas).not.toContain("s:aaaaaa"); // no switch in delete mode
  });
});
