import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../src/core/dashboard/dashboard.js";
import { reconcileTuiSessionRows } from "../../src/tui/session-list.js";

function row(session: string, state: { busy?: boolean; running?: boolean } = {}): SessionRow {
  return {
    session,
    label: session,
    sessionKind: "regular",
    workspacePath: null,
    independentSlot: null,
    group: null,
    kind: "claude",
    running: state.running ?? true,
    busy: state.busy ?? false,
    cumulativeBusyMs: 0,
    uptimeMs: 0,
    usage: null,
  };
}

describe("TUI session list", () => {
  it("orders busy, stopped attention, then healthy idle rows", () => {
    const result = reconcileTuiSessionRows(
      [row("idle"), row("stopped", { running: false }), row("busy", { busy: true })],
      undefined,
    );

    expect(result.rows.map((item) => item.session)).toEqual(["busy", "stopped", "idle"]);
  });

  it("preserves selection by session identity across refresh and reorder", () => {
    const result = reconcileTuiSessionRows(
      [row("selected"), row("new-busy", { busy: true }), row("other")],
      "selected",
    );

    expect(result.rows[result.selectedIndex]?.session).toBe("selected");
  });
});
