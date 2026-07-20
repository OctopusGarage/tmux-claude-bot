import { describe, expect, it } from "vitest";
import type { ProjectPickerLikeRow } from "../../src/core/projects/project-session-picker.js";
import {
  canCreateExistingIndependentGroup,
  projectSessionPrimaryIntent,
} from "../../src/core/projects/project-session-surface.js";

function row(
  over: Partial<ProjectPickerLikeRow> & Pick<ProjectPickerLikeRow, "sid" | "label">,
): ProjectPickerLikeRow {
  return { active: false, alive: false, isFree: false, ...over };
}

describe("Project Session Surface", () => {
  it("maps explicit picker actions into adapter-neutral primary intents", () => {
    expect(
      projectSessionPrimaryIntent(
        row({
          sid: "abc123",
          label: "App",
          active: false,
          alive: true,
          primaryAction: "switch-session",
        }),
      ),
    ).toEqual({ kind: "switch", sid: "abc123" });

    expect(
      projectSessionPrimaryIntent(
        row({
          sid: "def456",
          label: "Stopped",
          active: false,
          alive: false,
          primaryAction: "create-session",
        }),
      ),
    ).toEqual({ kind: "create", sid: "def456" });

    expect(
      projectSessionPrimaryIntent(
        row({
          sid: "cur789",
          label: "Current",
          active: true,
          alive: true,
          primaryAction: null,
        }),
      ),
    ).toEqual({ kind: "inert" });
  });

  it("preserves legacy summary fallback while adapters migrate off action ids", () => {
    expect(
      projectSessionPrimaryIntent(
        row({
          sid: "live",
          label: "Live",
          active: false,
          alive: true,
        }),
      ),
    ).toEqual({ kind: "switch", sid: "live" });

    expect(
      projectSessionPrimaryIntent(
        row({
          sid: "stopped",
          label: "Stopped",
          active: false,
          alive: false,
        }),
      ),
    ).toEqual({ kind: "create", sid: "stopped" });
  });

  it("centralizes existing independent group availability", () => {
    expect(
      canCreateExistingIndependentGroup(
        row({
          sid: "free1",
          label: "Free",
          active: false,
          alive: true,
          actionIds: ["switch-session", "create-existing-independent-group"],
        }),
      ),
    ).toBe(true);

    expect(
      canCreateExistingIndependentGroup(
        row({
          sid: "regular",
          label: "Regular",
          active: false,
          alive: true,
          actionIds: ["switch-session"],
        }),
      ),
    ).toBe(false);
  });
});
