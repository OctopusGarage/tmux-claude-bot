import { describe, expect, it } from "vitest";
import {
  ACTION_META,
  buildHelpBody,
  CONTROL_INTERRUPTS,
  CONTROL_LIFECYCLE,
  CONTROL_ROWS_FULL,
  getImmediateActions,
  getLarkQueued,
  getTelegramActions,
  HELP_SESSION_ROWS,
} from "../../src/core/command/action-registry.js";

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

describe("canonical control rows", () => {
  it("interrupts row is the same single order shared by every surface", () => {
    expect(CONTROL_INTERRUPTS).toEqual(["esc", "enter", "interrupt"]);
  });

  it("interrupt button carries the danger style", () => {
    expect(CONTROL_INTERRUPTS).toContain("interrupt");
    expect(ACTION_META["interrupt"]?.larkStyle).toBe("danger");
  });

  it("the full control rows are interrupts → lifecycle → navigation", () => {
    expect(CONTROL_ROWS_FULL[0]).toEqual(CONTROL_INTERRUPTS);
    expect(CONTROL_ROWS_FULL[1]).toEqual(CONTROL_LIFECYCLE);
    expect(CONTROL_ROWS_FULL.flat()).toContain("tab");
    expect(CONTROL_LIFECYCLE).toContain("exit");
  });

  it("the help Session rows add start + status to the full control rows", () => {
    const all = HELP_SESSION_ROWS.flat();
    expect(all).toContain("tab");
    expect(all).toContain("start");
    expect(all).toContain("exit");
    expect(all).toContain("status");
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

  it("telegram help contains the five-category section headers (using zh channel)", () => {
    const body = buildHelpBody("telegram", "telegram");
    expect(body).toMatch(/▶️/); // Session
    expect(body).toMatch(/📂/); // Projects
    expect(body).toMatch(/⚙️/); // Settings
    expect(body).toMatch(/🛠/); // Diagnostics
  });
});
