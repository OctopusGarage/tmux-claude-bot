import { describe, expect, it } from "vitest";
import {
  groupBoundCard,
  groupPickerCard,
  helpCard,
  projectListCard,
  recentListCard,
  resultCard,
  startPickerCard,
  viewCard,
} from "../../../src/adapters/lark/cards.js";
import type { ProjectButton, RecentButton } from "../../../src/core/project-ops.js";

// Minimal structural shapes for navigating a schema-2.0 card in assertions.
interface Card {
  header?: { title?: { content?: string } };
  body: { elements: Element[] };
}
interface Element {
  tag: string;
  content?: string;
  behaviors?: { value?: { cmd?: string; sid?: string; idx?: number } }[];
  columns?: { elements?: Element[] }[];
}

const cardOf = (c: object): Card => c as Card;
const mds = (c: Card) => c.body.elements.filter((e) => e.tag === "markdown");

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

describe("resultCard", () => {
  it("carries the full inline control panel (Feishu has no / discovery)", () => {
    const card = cardOf(resultCard("hi"));

    expect(mds(card).some((d) => d.content === "hi")).toBe(true);

    expect(allCmds(card)).toEqual([
      "esc",
      "enter",
      "interrupt",
      "clear",
      "compact",
      "restart",
      "peek",
      "history",
      "queuestatus",
      "listalive",
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
      "clear",
      "compact",
      "restart",
      "peek",
      "history",
      "queuestatus",
      "current",
      "help",
    ]);
    expect(allCmds(card)).not.toContain("listalive");
  });
});

describe("viewCard", () => {
  it("carries the inline control panel", () => {
    const card = cardOf(viewCard("👁 tmux 画面", "pane body"));
    expect(card.header?.title?.content).toBe("👁 tmux 画面");
    expect(mds(card).some((d) => d.content === "pane body")).toBe(true);
    expect(allCmds(card)).toEqual([
      "esc",
      "enter",
      "interrupt",
      "clear",
      "compact",
      "restart",
      "peek",
      "history",
      "queuestatus",
      "listalive",
      "current",
      "help",
    ]);
  });

  it("uses the （空） placeholder for empty body", () => {
    const card = cardOf(viewCard("t", ""));
    expect(mds(card).some((d) => d.content === "（空）")).toBe(true);
  });
});

describe("projectListCard", () => {
  it("renders switch+remove for inactive, inert 当前 for active", () => {
    const projects: ProjectButton[] = [
      { sid: "aaaaaa", label: "proj-a", active: false },
      { sid: "bbbbbb", label: "proj-b", active: true },
    ];
    const card = cardOf(projectListCard(projects));
    expect(card.header?.title?.content).toBe("活跃项目 (2)");
    expect(allCmds(card)).toEqual(["switch", "remove", "noop"]);
  });

  it("shows an empty hint when there are no projects", () => {
    const card = cardOf(projectListCard([]));
    expect(card.header?.title?.content).toBe("活跃项目 (0)");
    expect(mds(card).some((d) => d.content?.includes("没有活跃项目"))).toBe(true);
  });

  it("in a group: read-only — no switch/remove, just the active marker", () => {
    const projects: ProjectButton[] = [
      { sid: "aaaaaa", label: "proj-a", active: false },
      { sid: "bbbbbb", label: "proj-b", active: true },
    ];
    const card = cardOf(projectListCard(projects, true));
    expect(allCmds(card)).toEqual(["noop"]); // active marker only; no remove button
    expect(allCmds(card)).not.toContain("remove");
  });
});

describe("recentListCard", () => {
  it("switch for alive, create for stopped, inert for active", () => {
    const projects: RecentButton[] = [
      { sid: "aaaaaa", label: "alive", alive: true, active: false },
      { sid: "bbbbbb", label: "stopped", alive: false, active: false },
      { sid: "cccccc", label: "current", alive: true, active: true },
    ];
    const card = cardOf(recentListCard(projects));
    expect(allCmds(card)).toEqual(["switch", "addrecent", "noop"]);
  });

  it("in a group: read-only — no switch/create, just the active marker", () => {
    const projects: RecentButton[] = [
      { sid: "aaaaaa", label: "alive", alive: true, active: false },
      { sid: "bbbbbb", label: "stopped", alive: false, active: false },
      { sid: "cccccc", label: "current", alive: true, active: true },
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
      "enter",
      "esc",
      "interrupt",
      "restart",
      "clear",
      "compact",
      "up",
      "down",
      "tab",
      "status",
      "start",
      "exit",
      "peek",
      "history",
      "queuestatus",
      "listalive",
      "recent",
      "current",
      "groupmenu",
      "voicelangmenu",
      "uilangmenu",
    ]);
  });

  it("in a group: drops list-all / recent / make-group management entries", () => {
    const card = cardOf(helpCard(true));
    const cmds = allCmds(card);
    expect(cmds).not.toContain("listalive");
    expect(cmds).not.toContain("recent");
    expect(cmds).not.toContain("groupmenu");
    // work surface stays
    expect(cmds).toEqual(
      expect.arrayContaining(["peek", "history", "queuestatus", "current", "uilangmenu"]),
    );
  });
});

describe("groupPickerCard", () => {
  const projects: RecentButton[] = [
    { sid: "a1", label: "projA", alive: true, active: false },
    { sid: "b2", label: "projB", alive: false, active: false },
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
  });
});

describe("groupBoundCard", () => {
  it("shows restore / rebind / unbind buttons and the bound label", () => {
    const card = cardOf(groupBoundCard("projX"));
    expect(allCmds(card)).toEqual(["restore", "rebind", "unbind"]);
    expect(mds(card).some((d) => d.content?.includes("projX"))).toBe(true);
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
