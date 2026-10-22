import { describe, expect, it, vi } from "vitest";

const promptTranslateMocks = vi.hoisted(() => ({
  checkPromptTranslateSupportMock: vi.fn(() => ({
    ready: true,
    python: "/opt/tcb/.venv/bin/python",
  })),
  isPromptTranslateInstallableMock: vi.fn(() => false),
  checkVoiceSupportMock: vi.fn(() => ({ ready: true, bin: "/opt/tcb/.venv/bin/mlx_whisper" })),
}));

vi.mock("../src/core/read/prompt-translation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/read/prompt-translation.js")>()),
  checkPromptTranslateSupport: promptTranslateMocks.checkPromptTranslateSupportMock,
  isPromptTranslateInstallable: promptTranslateMocks.isPromptTranslateInstallableMock,
}));
vi.mock("../src/core/read/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/read/voice-support.js")>()),
  checkVoiceSupport: promptTranslateMocks.checkVoiceSupportMock,
}));

import {
  buildBrowseKeyboard,
  buildControlKeyboard,
  buildExpandedControlKeyboard,
  buildLangKeyboard,
  buildOpportunityNotificationKeyboard,
  buildProjectDeleteKeyboard,
  buildProjectKeyboard,
  buildPromptTranslateKeyboard,
  buildRecentKeyboard,
  buildSessionsKeyboard,
  buildStartPickerKeyboard,
  encodeControlAction,
  parseCallbackData,
} from "../src/adapters/telegram/keyboards.js";
import type { BrowseView } from "../src/core/projects/dir-browser.js";
import { UI_ICONS } from "../src/shared/ui/icons.js";

function callbackDatas(kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) {
  return kb.inline_keyboard.flat().map((b) => b.callback_data);
}

type ProjectKeyboardItem = Parameters<typeof buildProjectKeyboard>[0][number];
type RecentKeyboardItem = Parameters<typeof buildRecentKeyboard>[0][number];

const projectButton = (
  over: Partial<ProjectKeyboardItem> & Pick<ProjectKeyboardItem, "sid" | "label">,
): ProjectKeyboardItem => ({ active: false, alive: true, isFree: false, ...over });
const recentButton = (
  over: Partial<RecentKeyboardItem> & Pick<RecentKeyboardItem, "sid" | "label">,
): RecentKeyboardItem => ({ active: false, alive: false, isFree: false, ...over });

describe("directory browser keyboard", () => {
  it("parses every br:* callback shape", () => {
    expect(parseCallbackData("br:cd:3")).toEqual({
      kind: "browse",
      action: { kind: "open", index: 3 },
    });
    expect(parseCallbackData("br:rt:0")).toEqual({
      kind: "browse",
      action: { kind: "root", index: 0 },
    });
    expect(parseCallbackData("br:pg:2")).toEqual({
      kind: "browse",
      action: { kind: "page", page: 2 },
    });
    expect(parseCallbackData("br:up")).toEqual({ kind: "browse", action: { kind: "up" } });
    expect(parseCallbackData("br:sel")).toEqual({ kind: "browseselect" });
    expect(parseCallbackData("br:nf")).toEqual({ kind: "browsenewfolder" });
    expect(parseCallbackData("br:x")).toEqual({ kind: "browsecancel" });
  });

  it("parses the independent-session toggle and its cancel", () => {
    expect(parseCallbackData("nf")).toEqual({ kind: "newfree" });
    expect(parseCallbackData("nfx")).toEqual({ kind: "newfreecancel" });
  });

  it("parses qx:<sid>:<msgId> queue-cancel (msgId keeps its '-', not its ':')", () => {
    expect(parseCallbackData("qx:ab12:1700-deadbeef")).toEqual({
      kind: "qcancel",
      sid: "ab12",
      msgId: "1700-deadbeef",
    });
    expect(parseCallbackData("qx:ab12")).toBeNull(); // missing msgId
    expect(parseCallbackData("qx::x")).toBeNull(); // empty sid
  });

  it("parses the voice / translation / ui menu toggles", () => {
    expect(parseCallbackData("vlm")).toEqual({ kind: "voicelangmenu" });
    expect(parseCallbackData("vi")).toEqual({ kind: "voiceinstall" });
    expect(parseCallbackData("ulm")).toEqual({ kind: "uilangmenu" });
    expect(parseCallbackData("ptm")).toEqual({ kind: "prompttranslatemenu" });
    expect(parseCallbackData("pti")).toEqual({ kind: "prompttranslateinstall" });
  });

  it("rejects malformed br:* callbacks", () => {
    expect(parseCallbackData("br:cd:x")).toBeNull(); // non-numeric index
    expect(parseCallbackData("br:cd:-1")).toBeNull(); // negative index
    expect(parseCallbackData("br:cd")).toBeNull(); // missing index
    expect(parseCallbackData("br:nope")).toBeNull(); // unknown sub
    expect(parseCallbackData("br:up:1")).toBeNull(); // up takes no arg
  });

  const dirView: BrowseView = {
    kind: "dir",
    displayPath: "~/p",
    entries: [
      { label: "a", index: 0, isRepo: false },
      { label: "b", index: 1, isRepo: true },
    ],
    canGoUp: true,
    canCreate: true,
    cwd: "/home/u/p",
    page: 0,
    totalPages: 2,
  };

  it("renders subdir / up / pagination / create / cancel buttons for a dir view", () => {
    const kb = buildBrowseKeyboard(dirView);
    const data = callbackDatas(kb);
    expect(data).toContain("br:cd:0");
    expect(data).toContain("br:cd:1");
    expect(data).toContain("br:up");
    expect(data).toContain("br:pg:1"); // next page (page 0 of 2)
    expect(data).toContain("br:sel");
    expect(data).toContain("br:nf"); // new-folder button (creatable dir)
    expect(data).toContain("br:x");
    // Repository icon marks the git-repo entry (b), regular-session icon the plain one (a).
    const labels = kb.inline_keyboard.flat().map((btn) => btn.text);
    expect(labels).toContain(`${UI_ICONS.session.regular} a`);
    expect(labels).toContain(`${UI_ICONS.project.repository} b`);
  });

  it("uses br:rt for roots and omits create when not creatable", () => {
    const rootsView: BrowseView = {
      kind: "roots",
      displayPath: "",
      entries: [{ label: "~/work", index: 0, isRepo: false }],
      canGoUp: false,
      canCreate: false,
      cwd: null,
      page: 0,
      totalPages: 1,
    };
    const data = callbackDatas(buildBrowseKeyboard(rootsView));
    expect(data).toContain("br:rt:0");
    expect(data).not.toContain("br:sel");
    expect(data).toContain("br:x");
  });
});

describe("start-command picker", () => {
  it("parses sp:<idx>:<sid> into a startpick action", () => {
    expect(parseCallbackData("sp:1:abc123")).toEqual({ kind: "startpick", idx: 1, sid: "abc123" });
  });

  it("rejects malformed startpick callbacks", () => {
    expect(parseCallbackData("sp:x:abc123")).toBeNull(); // non-numeric idx
    expect(parseCallbackData("sp:1")).toBeNull(); // missing sid
  });

  it("builds one sp button per command, indexed and sid-tagged", () => {
    const kb = buildStartPickerKeyboard([{ label: "Stella" }, { label: "Work" }], "abc123");
    expect(callbackDatas(kb)).toEqual(["sp:0:abc123", "sp:1:abc123"]);
  });

  it("prefixes codex commands with a codex glyph, claude with the rocket", () => {
    const kb = buildStartPickerKeyboard(
      [
        { label: "YOLO", command: "claude-yolo", agent: "claude" },
        { label: "Stella", command: "codex-stella", agent: "codex" },
      ],
      "sid",
    );
    const texts = kb.inline_keyboard.flat().map((b) => b.text);
    expect(texts.find((t) => t.includes("YOLO"))).toContain("🟠");
    expect(texts.find((t) => t.includes("Stella"))).toContain("🔘");
  });
});

describe("parseCallbackData", () => {
  it("parses a control action", () => {
    expect(parseCallbackData("a:esc:abc123")).toEqual({
      kind: "act",
      action: "esc",
      sid: "abc123",
    });
  });

  it("parses confirmed control actions separately from first-tap actions", () => {
    expect(parseCallbackData("cf:exit:abc123")).toEqual({
      kind: "actconfirm",
      action: "exit",
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
    expect(parseCallbackData("ins:abc123")).toEqual({ kind: "inputslist", sid: "abc123" });
    expect(parseCallbackData("la")).toEqual({ kind: "listalive" });
    expect(parseCallbackData("qs")).toEqual({ kind: "queuestatus" });
  });

  it("parses voice-language picks and rejects unknown languages", () => {
    expect(parseCallbackData("vl:zh")).toEqual({ kind: "voicelang", lang: "zh" });
    expect(parseCallbackData("vl:yue")).toEqual({ kind: "voicelang", lang: "yue" });
    expect(parseCallbackData("vl:en")).toEqual({ kind: "voicelang", lang: "en" });
    expect(parseCallbackData("vl:ja")).toEqual({ kind: "voicelang", lang: "ja" });
    expect(parseCallbackData("vl:es")).toEqual({ kind: "voicelang", lang: "es" });
    expect(parseCallbackData("vl:auto")).toEqual({ kind: "voicelang", lang: "auto" });
    expect(parseCallbackData("vl:xx")).toBeNull();
    // UI-language picks (ul:) accept only supported UI langs.
    expect(parseCallbackData("ul:en")).toEqual({ kind: "uilang", lang: "en" });
    expect(parseCallbackData("ul:zh")).toEqual({ kind: "uilang", lang: "zh" });
    expect(parseCallbackData("ul:zh-TW")).toEqual({ kind: "uilang", lang: "zh-TW" });
    expect(parseCallbackData("ul:yue")).toEqual({ kind: "uilang", lang: "yue" });
    expect(parseCallbackData("ul:ja")).toEqual({ kind: "uilang", lang: "ja" });
    expect(parseCallbackData("ul:es")).toEqual({ kind: "uilang", lang: "es" });
    expect(parseCallbackData("ul:xx")).toBeNull();
    expect(parseCallbackData("ul:")).toBeNull();
    expect(parseCallbackData("vl:")).toBeNull();
  });

  it("parses prompt-translation toggles and rejects malformed data", () => {
    expect(parseCallbackData("pt:off")).toEqual({ kind: "prompttranslate", arg: "off" });
    expect(parseCallbackData("pt:on:zh:en")).toEqual({
      kind: "prompttranslate",
      arg: "on zh en",
    });
    expect(parseCallbackData("pt:on:zh")).toBeNull();
    expect(parseCallbackData("pt:on")).toBeNull();
    expect(parseCallbackData("pt:bogus")).toBeNull();
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

describe("buildOpportunityNotificationKeyboard", () => {
  it("renders safe per-suggestion telegram callbacks", () => {
    const kb = buildOpportunityNotificationKeyboard([
      {
        id: "api-20260729-ad409ff3",
        title: "Add explain command",
        projectName: "api",
        category: "developer-experience",
        confidence: "high",
        estimatedComplexity: "small",
        status: "proposed",
        value: "Faster support.",
      },
      {
        id: "api-20260729-bc510aa4",
        title: "Improve retry logs",
        projectName: "api",
        category: "reliability",
        confidence: "medium",
        estimatedComplexity: "small",
        status: "proposed",
        value: "Clearer incidents.",
      },
    ]) as unknown as { inline_keyboard: { text: string; callback_data?: string }[][] };

    expect(callbackDatas(kb)).toEqual(["od:ad409ff3", "ox:ad409ff3", "od:bc510aa4", "ox:bc510aa4"]);
    for (const data of callbackDatas(kb)) {
      expect(Buffer.byteLength(data ?? "", "utf-8")).toBeLessThanOrEqual(64);
    }
  });

  it("falls back to no telegram callbacks when a per-suggestion token exceeds the limit", () => {
    const keyboard = buildOpportunityNotificationKeyboard([
      {
        id: "x".repeat(80),
        title: "Long imported opportunity id",
        projectName: "api",
        category: "developer-experience",
        confidence: "high",
        estimatedComplexity: "small",
        status: "proposed",
        value: "Use typed /opportunity commands instead.",
      },
    ]);

    expect(keyboard).toBeUndefined();
  });
});

describe("buildControlKeyboard", () => {
  it("collapsed leads with esc/enter/interrupt + peek/history/list/queue plus a 'more' toggle", () => {
    const kb = buildControlKeyboard("abc123") as unknown as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const datas = callbackDatas(kb);
    // most-used mid-task controls are one tap (parity with Lark's control panel)
    expect(datas).toContain("a:esc:abc123");
    expect(datas).toContain("a:enter:abc123");
    expect(datas).toContain("a:interrupt:abc123");
    expect(datas).toContain("pk:abc123"); // peek
    expect(datas).toContain("hi:abc123"); // history
    expect(datas).toContain("ins:abc123"); // inputs
    expect(datas).toContain("la"); // list alive projects
    expect(datas).toContain("qs"); // queue status
    expect(datas).toContain("m:abc123"); // expand toggle
    // clear/compact/restart move to the expanded view
    expect(datas).not.toContain("a:clear:abc123");
    expect(datas).not.toContain("a:compact:abc123");
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
    expect(datas).toContain("a:tab:abc123");
    expect(datas).toContain("a:exit:abc123");
    // view actions
    expect(datas).toContain("pk:abc123"); // peek
    expect(datas).toContain("hi:abc123"); // history
    expect(datas).toContain("ins:abc123"); // inputs
    expect(datas).toContain("la"); // list alive projects
    expect(datas).toContain("qs"); // queue status
    expect(datas).toContain("vlm"); // voice settings
    expect(datas).toContain("ptm"); // translation settings
    expect(datas).toContain("ulm"); // UI language settings
    expect(datas).toContain("l:abc123"); // collapse toggle
    expect(datas).not.toContain("m:abc123"); // no expand toggle when already expanded
  });

  it("shows install instead of voice settings when voice is unavailable", () => {
    promptTranslateMocks.checkVoiceSupportMock.mockReturnValueOnce({
      ready: false,
      reason: "not-installed",
    } as never);

    const kb = buildExpandedControlKeyboard("abc123") as unknown as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const datas = callbackDatas(kb);

    expect(datas).toContain("vi");
    expect(datas).not.toContain("vlm");
  });
});

describe("buildPromptTranslateKeyboard", () => {
  it("shows a prompt translation picker with off / source presets when ready", () => {
    const kb = buildPromptTranslateKeyboard() as unknown as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const datas = callbackDatas(kb);
    expect(datas).toContain("pt:off");
    expect(datas).toContain("pt:on:zh:en");
    expect(datas).toContain("pt:on:yue:en");
    expect(datas).toContain("pt:on:ja:en");
    expect(datas).toContain("pt:on:es:en");
    expect(datas).not.toContain("pti");
    for (const r of kb.inline_keyboard) expect(r.length).toBeLessThanOrEqual(1);
  });

  it("shows only the install button when translation support is missing", () => {
    promptTranslateMocks.checkPromptTranslateSupportMock.mockReturnValueOnce({
      ready: false,
    } as never);
    promptTranslateMocks.isPromptTranslateInstallableMock.mockReturnValueOnce(true);

    const kb = buildPromptTranslateKeyboard() as unknown as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const datas = callbackDatas(kb);

    expect(datas).toEqual(["pti"]);
  });
});

function rows(kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) {
  return kb.inline_keyboard;
}

describe("buildProjectKeyboard", () => {
  it("renders one full-width switch row per project plus a delete-mode toggle", () => {
    const kb = buildProjectKeyboard([
      projectButton({ sid: "aaaaaa", label: "proj-a", active: false }),
      projectButton({ sid: "bbbbbb", label: "proj-b", active: true }),
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
      recentButton({ sid: "aaaaaa", label: "alive-proj", alive: true, active: false }),
      recentButton({ sid: "bbbbbb", label: "active-proj", alive: true, active: true }),
      recentButton({ sid: "cccccc", label: "dead-proj", alive: false, active: false }),
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
      projectButton({ sid: "aaaaaa", label: "proj-a", active: false }),
      projectButton({ sid: "bbbbbb", label: "proj-b", active: true }),
    ]) as unknown as { inline_keyboard: { text: string; callback_data?: string }[][] };
    const datas = callbackDatas(kb);
    for (const r of rows(kb)) expect(r.length).toBe(1);
    expect(datas).toContain("r:aaaaaa");
    expect(datas).toContain("r:bbbbbb"); // active can be deleted too
    expect(datas).toContain("dl"); // back to list
    expect(datas).not.toContain("s:aaaaaa"); // no switch in delete mode
  });
});

describe("buildLangKeyboard", () => {
  it("marks the current language with the ok icon and makes it inert", () => {
    const kb = buildLangKeyboard("zh") as unknown as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const buttons = kb.inline_keyboard.flat();
    const current = buttons.find((b) => b.text.startsWith(UI_ICONS.tone.ok));
    expect(current?.callback_data).toBe("noop");
    expect(callbackDatas(kb)).toContain("ul:en");
    expect(callbackDatas(kb)).not.toContain("ul:zh"); // current isn't re-selectable
    // one language per row
    for (const r of rows(kb)) expect(r.length).toBe(1);
  });
});

describe("buildSessionsKeyboard", () => {
  it("renders one row per session: short id + age label, resume via rs:<uuid>", () => {
    const now = Date.now();
    const kb = buildSessionsKeyboard([
      { sessionId: "aaaaaaaa-1111-2222-3333-444444444444", mtime: new Date(now - 5 * 60_000) },
      { sessionId: "bbbbbbbb-1111-2222-3333-444444444444", mtime: new Date(now - 3 * 3_600_000) },
      { sessionId: "cccccccc-1111-2222-3333-444444444444", mtime: new Date(now - 2 * 86_400_000) },
    ]) as unknown as { inline_keyboard: { text: string; callback_data?: string }[][] };

    const buttons = kb.inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual([
      "rs:aaaaaaaa-1111-2222-3333-444444444444",
      "rs:bbbbbbbb-1111-2222-3333-444444444444",
      "rs:cccccccc-1111-2222-3333-444444444444",
    ]);
    // labels: 8-char id prefix + relative age in m / h / d
    expect(buttons[0]?.text).toBe("aaaaaaaa · 5m");
    expect(buttons[1]?.text).toBe("bbbbbbbb · 3h");
    expect(buttons[2]?.text).toBe("cccccccc · 2d");
    for (const r of rows(kb)) expect(r.length).toBe(1);
  });
});
