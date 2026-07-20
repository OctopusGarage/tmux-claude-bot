import { describe, expect, it } from "vitest";
import { zh } from "../../src/core/i18n/catalog/zh.js";
import {
  decorateProjectListLabel,
  formatProjectStatusLine,
  formatProjectSummaryBlock,
  PROJECT_SUMMARY_ICONS,
} from "../../src/core/projects/project-summary-view.js";
import { UI_ICONS } from "../../src/shared/ui/icons.js";

describe("project-summary-view", () => {
  it("centralizes project list glyphs", () => {
    expect(PROJECT_SUMMARY_ICONS.busy).toBe(UI_ICONS.session.busy);
    expect(
      decorateProjectListLabel("repo", {
        agentKind: "codex",
        agentBusy: true,
        pathDrifted: true,
      }),
    ).toBe(`${UI_ICONS.agent.codex}${UI_ICONS.session.busy} repo ${UI_ICONS.session.driftedPath}`);
  });

  it("formats localized project status lines", () => {
    expect(
      formatProjectStatusLine(zh, {
        alive: true,
        isFree: true,
        agentKind: "codex",
        agentRunning: true,
        agentBusy: false,
        hasGroup: false,
        groupLabel: null,
      }),
    ).toBe(
      `${UI_ICONS.session.active} 会话：运行中 · ${UI_ICONS.agent.generic} Agent：Codex 空闲 · ${UI_ICONS.session.independent} 类型：独立会话 · ${UI_ICONS.group.none} 群：无`,
    );
  });

  it("can omit Lark-only group status for channels without project-group support", () => {
    expect(
      formatProjectStatusLine(
        zh,
        {
          alive: true,
          isFree: false,
          agentKind: "claude",
          agentRunning: true,
          agentBusy: false,
          hasGroup: true,
          groupLabel: "alpha-group",
        },
        { showGroup: false },
      ),
    ).toBe(
      `${UI_ICONS.session.active} 会话：运行中 · ${UI_ICONS.agent.generic} Agent：Claude 空闲 · ${UI_ICONS.session.regular} 类型：常规会话`,
    );
  });

  it("formats shared multi-line project summary blocks", () => {
    expect(
      formatProjectSummaryBlock([
        { label: "repo", statusLine: "会话：运行中", path: "/repo" },
        { label: "free", statusLine: "会话：未运行", path: null },
      ]),
    ).toBe(`repo\n会话：运行中\n${UI_ICONS.project.workspace} /repo\n\nfree\n会话：未运行`);
  });
});
