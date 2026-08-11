import { describe, expect, it } from "vitest";
import {
  defaultOperatorHomeAiToolFiles,
  readAiToolReadiness,
} from "../../../src/core/ai-tools/install-contract.js";
import { mcpProfileSpec } from "../../../src/core/mcp/profiles.js";

describe("AI tool install contract", () => {
  it("reports only valid managed role surfaces as ready", () => {
    const home = "/synthetic/operator-home";
    const files = defaultOperatorHomeAiToolFiles(home);
    const content = new Map(
      files.map((file) => [
        file.path,
        file.surface === "mcp" && file.profile !== undefined
          ? JSON.stringify(mcpProfileSpec(file.profile))
          : "skill",
      ]),
    );

    expect(
      readAiToolReadiness(home, {
        exists: (path) => content.has(path),
        read: (path) => content.get(path) ?? "",
      }),
    ).toEqual({
      skills: { installed: 2, expected: 2, state: "ready" },
      mcpProfiles: { installed: 2, expected: 2, state: "ready" },
    });

    const homeProfile = files.find((file) => file.profile === "home");
    expect(homeProfile).toBeDefined();
    content.set(homeProfile?.path ?? "", JSON.stringify({ profile: "home", tools: [] }));
    expect(
      readAiToolReadiness(home, {
        exists: (path) => content.has(path),
        read: (path) => content.get(path) ?? "",
      }).mcpProfiles,
    ).toEqual({ installed: 1, expected: 2, state: "attention" });
  });
});
