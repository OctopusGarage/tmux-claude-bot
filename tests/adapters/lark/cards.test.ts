import { describe, expect, it, vi } from "vitest";

const promptTranslateMocks = vi.hoisted(() => ({
  checkPromptTranslateSupportMock: vi.fn(() => ({
    ready: true,
    python: "/opt/tcb/.venv/bin/python",
  })),
  isPromptTranslateInstallableMock: vi.fn(() => false),
  checkVoiceSupportMock: vi.fn(() => ({ ready: true, bin: "/opt/tcb/.venv/bin/mlx_whisper" })),
}));

vi.mock("../../../src/core/read/prompt-translation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/prompt-translation.js")>()),
  checkPromptTranslateSupport: promptTranslateMocks.checkPromptTranslateSupportMock,
  isPromptTranslateInstallable: promptTranslateMocks.isPromptTranslateInstallableMock,
}));
vi.mock("../../../src/core/read/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/voice-support.js")>()),
  checkVoiceSupport: promptTranslateMocks.checkVoiceSupportMock,
}));

import {
  adoptConfirmCard,
  groupBoundCard,
  groupOverviewCard,
  groupPickerCard,
  helpCard,
  projectListCard,
  promptTranslateCard,
  recentListCard,
  resultCard,
  startPickerCard,
  viewCard,
} from "../../../src/adapters/lark/cards.js";
import type { ProjectButton, RecentButton } from "../../../src/core/projects/project-ops.js";
import { UI_ICONS } from "../../../src/shared/ui/icons.js";

// Minimal structural shapes for navigating a schema-2.0 card in assertions.
interface Card {
  header?: { title?: { content?: string } };
  body: { elements: Element[] };
}
interface Element {
  tag: string;
  content?: string;
  text?: { content?: string };
  hover_tips?: { content?: string };
  behaviors?: { value?: { cmd?: string; sid?: string; idx?: number; arg?: string } }[];
  columns?: { elements?: Element[] }[];
}

const cardOf = (c: object): Card => c as Card;
const mds = (c: Card) => c.body.elements.filter((e) => e.tag === "markdown");
const projectButton = (
  over: Partial<ProjectButton> & Pick<ProjectButton, "sid" | "label">,
): ProjectButton => ({ active: false, alive: true, isFree: false, ...over });
const recentButton = (
  over: Partial<RecentButton> & Pick<RecentButton, "sid" | "label">,
): RecentButton => ({ active: false, alive: false, isFree: false, ...over });

// Buttons sit directly inside column_set columns — walk the tree in order.
function collectButtons(elements: Element[]): Element[] {
  const out: Element[] = [];
  for (const e of elements) {
    if (e.tag === "button") out.push(e);
    else if (e.tag === "column_set" && e.columns) {
      for (const col of e.columns) if (col.elements) out.push(...collectButtons(col.elements));
    }
  }
  return out;
}
const allCmds = (c: Card): (string | undefined)[] =>
  collectButtons(c.body.elements).map((b) => b.behaviors?.[0]?.value?.cmd);
const buttonRows = (c: Card): Element[] => c.body.elements.filter((e) => e.tag === "column_set");

describe("resultCard", () => {
  it("carries the full inline control panel (Feishu has no / discovery)", () => {
    const card = cardOf(resultCard("hi"));

    expect(mds(card).some((d) => d.content === "hi")).toBe(true);

    expect(allCmds(card)).toEqual([
      "esc",
      "enter",
      "interrupt",
      "tab",
      "restart",
      "clear",
      "compact",
      "exit",
      "peek",
      "history",
      "inputs",
      "status",
      "queuestatus",
      "ap_delegate",
      "dashboard",
      "recover",
      "listalive",
      "adoptlist",
      "current",
      "help",
    ]);
  });

  it("uses the (无输出) placeholder for empty output", () => {
    const card = cardOf(resultCard(""));
    expect(mds(card).some((d) => d.content === "(无输出)")).toBe(true);
  });

  it("in a group: drops the 'listalive' project-management entry", () => {
    const card = cardOf(resultCard("hi", "Claude", true));
    expect(allCmds(card)).toEqual([
      "esc",
      "enter",
      "interrupt",
      "tab",
      "restart",
      "clear",
      "compact",
      "exit",
      "peek",
      "history",
      "inputs",
      "status",
      "queuestatus",
      "ap_delegate",
      "current",
      "help",
    ]);
    expect(allCmds(card)).not.toContain("listalive");
    expect(allCmds(card)).not.toContain("dashboard");
    expect(allCmds(card)).not.toContain("recover");
  });

  it("adds PC hover tips and avoids dense button rows", () => {
    const card = cardOf(resultCard("hi"));
    const buttons = collectButtons(card.body.elements);

    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.hover_tips?.content === b.text?.content)).toBe(true);
    expect(Math.max(...buttonRows(card).map((r) => r.columns?.length ?? 0))).toBeLessThanOrEqual(3);
  });
});

describe("viewCard", () => {
  it("carries the inline control panel", () => {
    const card = cardOf(viewCard("👁 会话画面", "pane body"));
    expect(card.header?.title?.content).toBe("👁 会话画面");
    expect(mds(card).some((d) => d.content === "pane body")).toBe(true);
    expect(allCmds(card)).toEqual([
      "esc",
      "enter",
      "interrupt",
      "tab",
      "restart",
      "clear",
      "compact",
      "exit",
      "peek",
      "history",
      "inputs",
      "status",
      "queuestatus",
      "ap_delegate",
      "dashboard",
      "recover",
      "listalive",
      "adoptlist",
      "current",
      "help",
    ]);
  });

  it("uses the （空） placeholder for empty body", () => {
    const card = cardOf(viewCard("t", ""));
    expect(mds(card).some((d) => d.content === "（空）")).toBe(true);
  });

  it("idle (running=false): swaps control keys for start/projects/recover/help", () => {
    const card = cardOf(viewCard("👁 会话画面", "pane body", false, false));
    expect(allCmds(card)).toEqual(["start", "resume", "listalive", "recover", "help"]);
    expect(allCmds(card)).not.toContain("esc"); // no dead control keys when idle
  });
});

describe("adoptConfirmCard", () => {
  it("offers both normal takeover and free-project takeover", () => {
    const card = cardOf(adoptConfirmCard(4242, "Claude · proj · sess · task idle"));

    expect(allCmds(card)).toContain("adoptgo");
    expect(allCmds(card)).toContain("adoptfree");
  });
});

describe("projectListCard", () => {
  it("renders switch+remove for inactive, inert 当前 for active", () => {
    const projects: ProjectButton[] = [
      projectButton({ sid: "aaaaaa", label: "proj-a", active: false }),
      projectButton({ sid: "bbbbbb", label: "proj-b", active: true }),
    ];
    const card = cardOf(projectListCard(projects));
    expect(card.header?.title?.content).toBe("活跃会话 (2)");
    expect(allCmds(card)).toEqual(["switch", "remove", "noop"]);
  });

  it("renders project status and path when present", () => {
    const projects: ProjectButton[] = [
      projectButton({
        sid: "aaaaaa",
        label: "🔘 repo",
        active: false,
        statusLine: "Session: running · agent: codex idle · type: independent · group: none",
        path: "/repo",
      }),
    ];
    const card = cardOf(projectListCard(projects));

    const text = mds(card)
      .map((d) => d.content)
      .join("\n");
    expect(text).toContain("**🔘 repo**");
    expect(text).toContain(
      "Session: running · agent: codex idle · type: independent · group: none",
    );
    expect(text).toContain("`/repo`");
  });

  it("shows an empty hint when there are no projects", () => {
    const card = cardOf(projectListCard([]));
    expect(card.header?.title?.content).toBe("活跃会话 (0)");
    expect(mds(card).some((d) => d.content?.includes("没有活跃会话"))).toBe(true);
  });

  it("in a group: read-only — no switch/remove, just the active marker", () => {
    const projects: ProjectButton[] = [
      projectButton({ sid: "aaaaaa", label: "proj-a", active: false }),
      projectButton({ sid: "bbbbbb", label: "proj-b", active: true }),
    ];
    const card = cardOf(projectListCard(projects, true));
    expect(allCmds(card)).toEqual(["noop"]); // active marker only; no remove button
    expect(allCmds(card)).not.toContain("remove");
  });

  it("adds a group action for path-backed independent sessions in private chat", () => {
    const projects: ProjectButton[] = [
      projectButton({ sid: "aaaaaa", label: "proj-a", active: false }),
      projectButton({
        sid: "bbbbbb",
        label: `${UI_ICONS.session.independent} task · repo`,
        active: false,
        canCreateFreeGroup: true,
      }),
    ];
    const card = cardOf(projectListCard(projects));

    expect(allCmds(card)).toEqual(["switch", "remove", "switch", "makefreeprojectgroup", "remove"]);
  });

  it("lets picker actionIds override legacy free-group eligibility", () => {
    const row = projectButton({
      sid: "bbbbbb",
      label: `${UI_ICONS.session.independent} task · repo`,
      active: false,
      canCreateFreeGroup: true,
    }) as ProjectButton & { actionIds: [] };
    row.actionIds = [];

    const card = cardOf(projectListCard([row]));

    expect(allCmds(card)).toEqual(["switch", "remove"]);
  });

  it("adds the group action even when the independent session is current", () => {
    const projects: ProjectButton[] = [
      projectButton({
        sid: "bbbbbb",
        label: `${UI_ICONS.session.independent} task · repo`,
        active: true,
        canCreateFreeGroup: true,
      }),
    ];
    const card = cardOf(projectListCard(projects));

    expect(allCmds(card)).toEqual(["noop", "makefreeprojectgroup"]);
  });

  it("does not show the free-group action in a group", () => {
    const projects: ProjectButton[] = [
      projectButton({
        sid: "bbbbbb",
        label: `${UI_ICONS.session.independent} task · repo`,
        active: false,
        canCreateFreeGroup: true,
      }),
    ];
    const card = cardOf(projectListCard(projects, true));

    expect(allCmds(card)).toEqual([]);
  });
});

describe("recentListCard", () => {
  it("switch for alive, create for stopped, inert for active", () => {
    const projects: RecentButton[] = [
      recentButton({ sid: "aaaaaa", label: "alive", alive: true, active: false }),
      recentButton({ sid: "bbbbbb", label: "stopped", alive: false, active: false }),
      recentButton({ sid: "cccccc", label: "current", alive: true, active: true }),
    ];
    const card = cardOf(recentListCard(projects));
    expect(allCmds(card)).toEqual(["switch", "addrecent", "noop"]);
  });

  it("renders recent project status and path when present", () => {
    const projects: RecentButton[] = [
      recentButton({
        sid: "aaaaaa",
        label: "repo",
        alive: false,
        active: false,
        statusLine: "Session: stopped · agent: none · type: regular · group: docs",
        path: "/repo",
      }),
    ];
    const card = cardOf(recentListCard(projects));

    const text = mds(card)
      .map((d) => d.content)
      .join("\n");
    expect(text).toContain("**repo**");
    expect(text).toContain("Session: stopped · agent: none · type: regular · group: docs");
    expect(text).toContain("`/repo`");
  });

  it("in a group: read-only — no switch/create, just the active marker", () => {
    const projects: RecentButton[] = [
      recentButton({ sid: "aaaaaa", label: "alive", alive: true, active: false }),
      recentButton({ sid: "bbbbbb", label: "stopped", alive: false, active: false }),
      recentButton({ sid: "cccccc", label: "current", alive: true, active: true }),
    ];
    const card = cardOf(recentListCard(projects, true));
    expect(allCmds(card)).toEqual(["noop"]);
  });
});

describe("helpCard", () => {
  it("has a header title and the project/view shortcut buttons", () => {
    const card = cardOf(helpCard());

    expect(card.header?.title?.content).toBe("使用帮助");

    expect(allCmds(card)).toEqual([
      // Session rows (canonical control order: interrupts → lifecycle → nav → start/resume/status)
      "esc",
      "enter",
      "interrupt",
      "restart",
      "clear",
      "compact",
      "exit",
      "up",
      "down",
      "left",
      "right",
      "tab",
      "start",
      "resume",
      "status",
      // Projects / views (unchanged in this stage)
      "dashboard",
      "recover",
      "peek",
      "history",
      "inputs",
      "queuestatus",
      "addproject",
      "listalive",
      "recent",
      "adoptlist",
      "current",
      "statusinstall",
      "groupmenu",
      "freegroupmenu",
      "voicelangmenu",
      "prompttranslate",
      "uilangmenu",
    ]);
  });

  it("surfaces a voice-install button only when voice is installable", () => {
    expect(allCmds(cardOf(helpCard()))).not.toContain("voiceinstall");
    expect(allCmds(cardOf(helpCard(false, true)))).toContain("voiceinstall");
  });

  it("does not duplicate the voice-install button in the help card", () => {
    const cmds = allCmds(cardOf(helpCard(false, true)));
    expect(cmds.filter((cmd) => cmd === "voiceinstall")).toHaveLength(1);
  });

  it("shows only the install action on the voice card when voice is unavailable", () => {
    promptTranslateMocks.checkVoiceSupportMock.mockReturnValueOnce({
      ready: false,
      reason: "not-installed",
    } as never);

    const cmds = allCmds(cardOf(helpCard(false, true)));
    expect(cmds).toContain("voiceinstall");
    expect(cmds).not.toContain("voicelangmenu");
  });

  it("surfaces a prompt-translation install button only when installable", () => {
    const cmds = allCmds(cardOf(helpCard(false, false, true)));
    expect(cmds).toContain("translateinstall");
    expect(cmds).not.toContain("prompttranslate");
  });

  it("surfaces a prompt-translation menu button alongside voice and UI language", () => {
    const cmds = allCmds(cardOf(helpCard()));
    expect(cmds).toContain("prompttranslate");
  });

  it("does not duplicate the prompt-translation button in the help card", () => {
    const cmds = allCmds(cardOf(helpCard(false, false, true)));
    expect(cmds.filter((cmd) => cmd === "translateinstall")).toHaveLength(1);
  });

  it("in a group: drops list-all / recent / make-group management entries", () => {
    const card = cardOf(helpCard(true));
    const cmds = allCmds(card);
    expect(cmds).not.toContain("listalive");
    expect(cmds).not.toContain("recent");
    expect(cmds).not.toContain("groupmenu");
    // work surface stays
    expect(cmds).toEqual(
      expect.arrayContaining([
        "peek",
        "history",
        "queuestatus",
        "current",
        "prompttranslate",
        "uilangmenu",
      ]),
    );
  });

  it("in a group: includes binding management (restore/rebind/unbind) so the home menu is self-sufficient", () => {
    const cmds = allCmds(cardOf(helpCard(true)));
    expect(cmds).toEqual(expect.arrayContaining(["restore", "rebind", "unbind"]));
  });

  it("in a 1:1 chat: does NOT show group binding-management buttons", () => {
    const cmds = allCmds(cardOf(helpCard(false)));
    expect(cmds).not.toContain("restore");
    expect(cmds).not.toContain("unbind");
  });
});

describe("promptTranslateCard", () => {
  it("shows a prompt translation card with presets when ready", () => {
    const cmds = allCmds(cardOf(promptTranslateCard()));
    expect(cmds.filter((cmd) => cmd === "prompttranslate")).toHaveLength(5);
    expect(cmds).not.toContain("translateinstall");
  });

  it("shows only the install action when translation support is missing", () => {
    promptTranslateMocks.checkPromptTranslateSupportMock.mockReturnValueOnce({
      ready: false,
    } as never);
    promptTranslateMocks.isPromptTranslateInstallableMock.mockReturnValueOnce(true);

    const cmds = allCmds(cardOf(promptTranslateCard()));
    expect(cmds).toEqual(["translateinstall"]);
  });
});

describe("groupPickerCard", () => {
  const projects: RecentButton[] = [
    recentButton({ sid: "a1", label: "projA", alive: true, active: false }),
    recentButton({ sid: "b2", label: "projB", alive: false, active: false }),
  ];

  it("make mode: a 'makegroup' button per project carrying its sid", () => {
    const card = cardOf(groupPickerCard(projects, "make"));
    const btns = collectButtons(card.body.elements);
    expect(btns.map((b) => b.behaviors?.[0]?.value?.cmd)).toEqual(["makegroup", "makegroup"]);
    expect(btns.map((b) => b.behaviors?.[0]?.value?.sid)).toEqual(["a1", "b2"]);
  });

  it("bind mode: emits 'bindhere' buttons instead", () => {
    const card = cardOf(groupPickerCard(projects, "bind"));
    expect(allCmds(card)).toEqual(["bindhere", "bindhere"]);
  });

  it("empty: shows the no-projects hint and no buttons", () => {
    const card = cardOf(groupPickerCard([], "make"));
    expect(collectButtons(card.body.elements)).toHaveLength(0);
    expect(mds(card).length).toBeGreaterThan(0);
    expect(mds(card).some((d) => d.content?.includes("暂无可新建项目群"))).toBe(true);
    expect(mds(card).some((d) => d.content?.includes("暂无近期项目"))).toBe(false);
  });

  it("free mode empty state says it needs a regular project template", () => {
    const card = cardOf(groupPickerCard([], "free"));
    expect(mds(card).some((d) => d.content?.includes("暂无可新建并行项目群"))).toBe(true);
  });
});

describe("groupOverviewCard", () => {
  it("renders existing group status and path with the unified project row style", () => {
    const card = cardOf(
      groupOverviewCard(
        [
          {
            chatId: "oc_1",
            label: "repo-group",
            workspacePath: "/repo",
            statusLine: "Session: running · agent: codex idle · type: regular · group: repo-group",
          },
        ],
        [],
      ),
    );

    const text = mds(card)
      .map((d) => d.content)
      .join("\n");
    expect(text).toContain("**repo-group**");
    expect(text).toContain(
      "Session: running · agent: codex idle · type: regular · group: repo-group",
    );
    expect(text).toContain("`/repo`");
  });
});

describe("groupBoundCard", () => {
  it("shows restore / rebind / unbind buttons and the bound label", () => {
    const card = cardOf(groupBoundCard("projX", { path: "/proj/x", statusLine: "会话：运行中" }));
    expect(allCmds(card)).toEqual(["restore", "rebind", "unbind"]);
    expect(mds(card).some((d) => d.content?.includes("projX"))).toBe(true);
    expect(mds(card).some((d) => d.content?.includes("会话：运行中"))).toBe(true);
    expect(mds(card).some((d) => d.content?.includes("`/proj/x`"))).toBe(true);
  });
});

describe("startPickerCard", () => {
  it("renders one 'startpick' button per command, carrying its index", () => {
    const card = cardOf(
      startPickerCard([
        { label: "Stella", command: "CLAUDE_CONFIG_DIR=~/.claude-stella claude" },
        { label: "Work", command: "claude-work" },
      ]),
    );
    const btns = collectButtons(card.body.elements);
    expect(btns.map((b) => b.behaviors?.[0]?.value?.cmd)).toEqual(["startpick", "startpick"]);
    expect(btns.map((b) => b.behaviors?.[0]?.value?.idx)).toEqual([0, 1]);
    // the command labels + raw commands are shown so the user can tell them apart
    const text = mds(card)
      .map((d) => d.content)
      .join("\n");
    expect(text).toContain("Stella");
    expect(text).toContain("claude-work");
  });
});
