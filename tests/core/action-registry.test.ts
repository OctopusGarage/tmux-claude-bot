import { describe, expect, it } from "vitest";
import {
  ACTION_META,
  buildHelpBody,
  getImmediateActions,
  getLarkQueued,
  getTelegramActions,
  LARK_CONTROL_ROWS,
  LARK_HELP_RUNNING_ROWS,
  TELEGRAM_EXPANDED_ROWS,
  TELEGRAM_PRIMARY_ROWS,
} from "../../src/core/action-registry.js";

describe("ACTION_META", () => {
  it("tab is immediate on Lark and registered on Telegram", () => {
    const m = ACTION_META["tab"];
    expect(m?.larkKind).toBe("immediate");
    expect(m?.telegram).toBe(true);
    expect(m?.btnKey).toBe("btnTab");
  });

  it("interrupt has danger style", () => {
    expect(ACTION_META["interrupt"]?.larkStyle).toBe("danger");
  });

  it("start has primary style", () => {
    expect(ACTION_META["start"]?.larkStyle).toBe("primary");
  });
});

describe("getImmediateActions", () => {
  it("includes tab, esc, enter, interrupt, up, down, clear, compact, status", () => {
    const set = getImmediateActions();
    for (const a of [
      "tab",
      "esc",
      "enter",
      "interrupt",
      "up",
      "down",
      "clear",
      "compact",
      "status",
    ] as const) {
      expect(set.has(a), `expected ${a} in IMMEDIATE`).toBe(true);
    }
  });

  it("does not include queued actions", () => {
    const set = getImmediateActions();
    for (const a of ["start", "restart", "exit"] as const) {
      expect(set.has(a), `${a} should not be in IMMEDIATE`).toBe(false);
    }
  });
});

describe("getLarkQueued", () => {
  it("includes start, restart, exit", () => {
    const set = getLarkQueued();
    for (const a of ["start", "restart", "exit"] as const) {
      expect(set.has(a), `expected ${a} in QUEUED`).toBe(true);
    }
  });
});

describe("getTelegramActions", () => {
  it("includes tab", () => {
    expect(getTelegramActions()).toContain("tab");
  });

  it("does not include actions with telegram: false", () => {
    // All current actions have telegram: true, so verify the filter works by checking count
    const actions = getTelegramActions();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => ACTION_META[a]?.telegram)).toBe(true);
  });
});

describe("button row groups", () => {
  it("TELEGRAM_PRIMARY_ROWS contains enter and interrupt on row 0", () => {
    expect(TELEGRAM_PRIMARY_ROWS[0]).toContain("enter");
    expect(TELEGRAM_PRIMARY_ROWS[0]).toContain("interrupt");
  });

  it("TELEGRAM_EXPANDED_ROWS contains tab", () => {
    const all = TELEGRAM_EXPANDED_ROWS.flat();
    expect(all).toContain("tab");
  });

  it("LARK_CONTROL_ROWS contains interrupt with danger style", () => {
    const all = LARK_CONTROL_ROWS.flat();
    expect(all).toContain("interrupt");
    expect(ACTION_META["interrupt"]?.larkStyle).toBe("danger");
  });

  it("LARK_HELP_RUNNING_ROWS contains tab", () => {
    const all = LARK_HELP_RUNNING_ROWS.flat();
    expect(all).toContain("tab");
  });

  it("LARK_HELP_RUNNING_ROWS contains start and exit", () => {
    const all = LARK_HELP_RUNNING_ROWS.flat();
    expect(all).toContain("start");
    expect(all).toContain("exit");
  });
});

describe("buildHelpBody", () => {
  it("telegram help includes /tab in the output", () => {
    const body = buildHelpBody("telegram", "telegram");
    expect(body).toContain("/tab");
  });

  it("lark help includes /tab in the output", () => {
    const body = buildHelpBody("lark", "lark");
    expect(body).toContain("/tab");
  });

  it("telegram help contains the section headers (using zh channel)", () => {
    const body = buildHelpBody("telegram", "telegram");
    expect(body).toMatch(/📂/);
    expect(body).toMatch(/⚡/);
    expect(body).toMatch(/🚀/);
  });
});
