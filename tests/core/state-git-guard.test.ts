import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  it("removes hooksPath from a contaminated install-root state repository", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "tcb-state-git-guard-install-"));
    const stateDir = join(installRoot, "state");
    mkdirSync(join(installRoot, "src"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(installRoot, "src", "cli.ts"), "export {};\n");
    writeFileSync(join(installRoot, "package.json"), '{"name":"tmux-claude-bot"}\n');
    writeFileSync(join(stateDir, "loop_backlog.json"), "{}\n");
    execFileSync("git", ["init"], { cwd: installRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: installRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: installRoot });
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: installRoot });
    execFileSync("git", ["add", "src/cli.ts", "package.json", "state/loop_backlog.json"], {
      cwd: installRoot,
    });
    execFileSync("git", ["commit", "-m", "bad baseline"], {
      cwd: installRoot,
      stdio: "ignore",
    });

    const result = disableStateRepositoryHooks(stateDir);

    expect(result).toEqual({
      gitRepository: false,
      removedHooksPath: null,
      contaminatedInstallRootGitRepository: true,
      removedInstallRootHooksPath: ".husky/_",
    });
    expect(gitConfigGet(installRoot, "core.hooksPath")).toBeNull();
  });
});
