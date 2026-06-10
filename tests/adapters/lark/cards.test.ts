import { describe, expect, it } from "vitest";
import {
  helpCard,
  projectListCard,
  recentListCard,
  resultCard,
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
  behaviors?: { value?: { cmd?: string; sid?: string } }[];
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
  it("collapsed: 7 view/control buttons plus a 'more' toggle", () => {
    const card = cardOf(resultCard("hi"));

    expect(mds(card).some((d) => d.content === "hi")).toBe(true);

    expect(allCmds(card)).toEqual([
      "esc",
      "clear",
      "compact",
      "peek",
      "history",
      "listalive",
      "queuestatus",
      "help",
    ]);
  });

  it("uses the (无输出) placeholder for empty output", () => {
    const card = cardOf(resultCard(""));
    expect(mds(card).some((d) => d.content === "(无输出)")).toBe(true);
  });
});

describe("viewCard", () => {
  it("carries the collapsed control buttons", () => {
    const card = cardOf(viewCard("👁 tmux 画面", "pane body"));
    expect(card.header?.title?.content).toBe("👁 tmux 画面");
    expect(mds(card).some((d) => d.content === "pane body")).toBe(true);
    expect(allCmds(card)).toEqual([
      "esc",
      "clear",
      "compact",
      "peek",
      "history",
      "listalive",
      "queuestatus",
      "help",
    ]);
  });

  it("uses the (空) placeholder for empty body", () => {
    const card = cardOf(viewCard("t", ""));
    expect(mds(card).some((d) => d.content === "(空)")).toBe(true);
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
      "status",
      "start",
      "exit",
      "peek",
      "history",
      "queuestatus",
      "listalive",
      "recent",
      "current",
    ]);
  });
});
