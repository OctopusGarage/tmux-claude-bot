import { describe, expect, it } from "vitest";
import {
  controlIntent,
  controlOutcome,
  controlServerEvent,
  initialInteractionState,
  projectOpenIntent,
  promptSendIntent,
} from "../../src/tui/interaction.js";

describe("TUI interaction", () => {
  it("requires confirmation before a dangerous control effect", () => {
    const result = controlIntent(initialInteractionState(), {
      action: "restart",
      session: "project",
      label: "Project",
    });

    expect(result.state.pendingDanger).toEqual({
      action: "restart",
      session: "project",
      label: "Project",
    });
    expect(result.state.status).toBe("Confirm restart for Project? y/N");
    expect(result.effect).toBeUndefined();
  });

  it("emits the control effect after confirmation", () => {
    const pending = controlIntent(initialInteractionState(), {
      action: "restart",
      session: "project",
      label: "Project",
    }).state;

    const result = controlOutcome(pending, "confirm");

    expect(result.state.pendingDanger).toBeNull();
    expect(result.state.status).toBe("→ restart → Project");
    expect(result.effect).toEqual({ kind: "control", action: "restart", session: "project" });
  });

  it("turns a prompt into a send effect and returns to the list", () => {
    const result = promptSendIntent(initialInteractionState(), {
      session: "project",
      label: "Project",
      text: "  fix the test  ",
    });

    expect(result.state).toMatchObject({ status: "→ sent to Project" });
    expect(result.state).not.toHaveProperty("mode");
    expect(result.effect).toEqual({ kind: "send", session: "project", text: "fix the test" });
  });

  it("turns a project choice into an open effect and retains its status", () => {
    const result = projectOpenIntent(initialInteractionState(), {
      sid: "project",
      label: "Project",
    });

    expect(result.state).toMatchObject({ status: "opening Project…" });
    expect(result.state).not.toHaveProperty("mode");
    expect(result.effect).toEqual({ kind: "open-project", sid: "project", label: "Project" });
  });

  it("maps Control server events to existing status text", () => {
    expect(
      controlServerEvent(initialInteractionState(), { kind: "disconnected" }).state.status,
    ).toBe("⚠ bot disconnected — reconnecting…");
    expect(
      controlServerEvent(initialInteractionState(), {
        kind: "reply",
        session: "long-project-session",
        output: "first\nsecond",
      }).state.status,
    ).toBe("✓ ng-project-session: first second");
  });
});
