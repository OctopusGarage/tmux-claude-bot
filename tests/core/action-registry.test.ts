import { describe, expect, it } from "vitest";
import {
  ACTION_META,
  actionButtonRows,
  actionButtonSpec,
  actionConfirmationText,
  actionConfirmButtonText,
  actionLabel,
  BOT_COMMANDS,
  buildHelpBody,
  CONTROL_INTERRUPTS,
  CONTROL_LIFECYCLE,
  CONTROL_ROWS_FULL,
  getActionConfirmation,
  getImmediateActions,
  getQueuedActions,
  getTelegramActions,
  HELP_SESSION_ROWS,
  requiresActionConfirmation,
} from "../../src/core/command/action-registry.js";
import {
  buildHelpBody as buildHelpCatalogBody,
  BOT_COMMANDS as HELP_BOT_COMMANDS,
} from "../../src/core/command/help-catalog.js";

describe("ACTION_META", () => {
  it("tab is immediate and registered on Telegram", () => {
    const m = ACTION_META.tab;
    expect(m?.queuePolicy).toBe("immediate");
    expect(m?.telegram).toBe(true);
    expect(m?.btnKey).toBe("btnTab");
  });

  it("uses channel-neutral queue policy metadata", () => {
    expect(ACTION_META.restart?.queuePolicy).toBe("queued");
    expect("larkKind" in (ACTION_META.restart ?? {})).toBe(false);
  });

  it("interrupt has danger button style", () => {
    expect(ACTION_META.interrupt?.buttonStyle).toBe("danger");
    expect("larkStyle" in (ACTION_META.interrupt ?? {})).toBe(false);
  });

  it("start has primary button style", () => {
    expect(ACTION_META.start?.buttonStyle).toBe("primary");
  });

  it("marks destructive or context-resetting actions as confirmation-gated", () => {
    expect(
      ["exit", "restart", "clear", "compact"].filter((a) => requiresActionConfirmation(a as never)),
    ).toEqual(["exit", "restart", "clear", "compact"]);
    expect(requiresActionConfirmation("interrupt")).toBe(false);
    expect(getActionConfirmation("exit")?.severity).toBe("danger");
    expect(getActionConfirmation("clear")?.severity).toBe("warning");
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
    for (const a of ["start", "resume", "restart", "exit"] as const) {
      expect(set.has(a), `${a} should not be in IMMEDIATE`).toBe(false);
    }
  });
});

describe("getQueuedActions", () => {
  it("includes start, resume, restart, exit", () => {
    const set = getQueuedActions();
    for (const a of ["start", "resume", "restart", "exit"] as const) {
      expect(set.has(a), `expected ${a} in QUEUED`).toBe(true);
    }
  });

  it("exposes queued actions without naming a specific adapter", () => {
    expect([...getQueuedActions()].sort()).toEqual(["exit", "restart", "resume", "start"]);
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

describe("BOT_COMMANDS", () => {
  it("keeps menu/help taxonomy owned by the help catalog module", () => {
    expect(BOT_COMMANDS).toBe(HELP_BOT_COMMANDS);
    expect(buildHelpBody).toBe(buildHelpCatalogBody);
  });

  it("contains unique commands", () => {
    const commands = BOT_COMMANDS.map((c) => c.command);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("advertises Resource Guardian through the existing sysload command", () => {
    expect(BOT_COMMANDS.find((item) => item.command === "sysload")?.description).toContain(
      "Resource Guardian",
    );
    expect(buildHelpBody("telegram", "telegram")).toContain("资源守护");
  });
});

describe("canonical control rows", () => {
  it("interrupts row is the same single order shared by every surface", () => {
    expect(CONTROL_INTERRUPTS).toEqual(["esc", "enter", "interrupt"]);
  });

  it("interrupt button carries the danger style", () => {
    expect(CONTROL_INTERRUPTS).toContain("interrupt");
    expect(ACTION_META.interrupt?.buttonStyle).toBe("danger");
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
    expect(all).toContain("resume");
    expect(all).toContain("exit");
    expect(all).toContain("status");
  });
});

describe("actionButtonRows", () => {
  it("renders localized action labels and styles without adapter metadata leaks", () => {
    expect(actionButtonRows([["interrupt", "start"]], "telegram")).toEqual([
      [
        { action: "interrupt", text: "🛑 中断", style: "danger" },
        { action: "start", text: "🚀 启动", style: "primary" },
      ],
    ]);
  });

  it("covers label, confirmation, and unknown action fallbacks", () => {
    expect(actionLabel("status", "lark")).toContain("状态");
    expect(actionConfirmationText("exit", "telegram", "proj")).toContain("proj");
    expect(actionConfirmButtonText("clear", "telegram")).toContain("确认");
    expect(actionConfirmationText("status", "telegram", "proj")).toBeNull();
    expect(actionButtonSpec("text", "telegram")).toBeNull();
    expect(actionButtonRows([["text", "status"]], "telegram")).toEqual([
      [{ action: "status", text: "📊 状态" }],
    ]);
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

  it("documents every Telegram menu command", () => {
    const body = buildHelpBody("telegram", "telegram");
    for (const { command } of BOT_COMMANDS) {
      expect(body, `missing /${command} in help`).toContain(`/${command}`);
    }
  });
});
