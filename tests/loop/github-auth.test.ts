import { describe, expect, it } from "vitest";
import {
  githubAccountRequirement,
  githubCommandForAccount,
} from "../../src/core/loop/github-auth.js";

describe("GitHub account binding", () => {
  it("binds every command to the configured account", () => {
    expect(githubCommandForAccount("Kingson4Wu", "pr close 42")).toBe(
      `GH_TOKEN="$(gh auth token --user 'Kingson4Wu')" gh pr close 42`,
    );
  });

  it("rejects a missing account instead of falling back to global gh state", () => {
    expect(() => githubCommandForAccount(undefined, "pr close 42")).toThrow(
      /requires an explicit githubAccount/i,
    );
    expect(githubAccountRequirement(undefined, "PR review")).toMatch(
      /refusing to use the global gh active account/i,
    );
  });
});
