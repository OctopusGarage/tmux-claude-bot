import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disableStateRepositoryHooks } from "../../src/core/infra/state-git-guard.js";

function gitConfigGet(cwd: string, key: string): string | null {
  try {
    return execFileSync("git", ["config", "--get", key], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

describe("state repository git guard", () => {
  it("removes hooksPath from a git-backed state repository", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-state-git-guard-"));
    execFileSync("git", ["init"], { cwd: stateDir, stdio: "ignore" });
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], {
      cwd: stateDir,
      stdio: "ignore",
    });

    const result = disableStateRepositoryHooks(stateDir);

    expect(result).toEqual({ gitRepository: true, removedHooksPath: ".husky/_" });
    expect(gitConfigGet(stateDir, "core.hooksPath")).toBeNull();
  });

  it("is a no-op for a non-git state directory", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-state-git-guard-"));

    expect(disableStateRepositoryHooks(stateDir)).toEqual({
      gitRepository: false,
      removedHooksPath: null,
    });
  });
});
