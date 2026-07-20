import { describe, expect, it } from "vitest";
import {
  confirmDangerousControl,
  dangerousControlPrompt,
} from "../../src/tui/danger-confirmation.js";

describe("TUI dangerous control confirmation", () => {
  it("asks for confirmation before a dangerous control action", () => {
    expect(dangerousControlPrompt("restart", "proj-a")).toBe("Confirm restart for proj-a? y/N");
    expect(dangerousControlPrompt("enter", "proj-a")).toBeNull();
  });

  it("confirms only on y/Y and cancels on anything else", () => {
    expect(confirmDangerousControl("y")).toBe("confirm");
    expect(confirmDangerousControl("Y")).toBe("confirm");
    expect(confirmDangerousControl("n")).toBe("cancel");
    expect(confirmDangerousControl("\u001b")).toBe("cancel");
  });
});
