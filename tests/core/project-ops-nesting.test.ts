import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botSelfRepoWarning } from "../../src/core/project-ops.js";

describe("botSelfRepoWarning (nesting guard)", () => {
  it("warns when the project path is a tmux-claude-bot checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "self-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tmux-claude-bot" }));
    expect(botSelfRepoWarning(dir)).toContain("嵌套");
  });

  it("returns null for a normal project", () => {
    const dir = mkdtempSync(join(tmpdir(), "norm-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-app" }));
    expect(botSelfRepoWarning(dir)).toBeNull();
  });

  it("returns null for no package.json or an empty path", () => {
    const dir = mkdtempSync(join(tmpdir(), "empty-"));
    expect(botSelfRepoWarning(dir)).toBeNull();
    expect(botSelfRepoWarning(null)).toBeNull();
    expect(botSelfRepoWarning(undefined)).toBeNull();
  });
});
