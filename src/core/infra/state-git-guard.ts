import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type StateGitGuardResult = {
  gitRepository: boolean;
  removedHooksPath: string | null;
};

function gitConfigGet(cwd: string, key: string): string | null {
  try {
    return execFileSync("git", ["config", "--get", key], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function disableStateRepositoryHooks(stateDir: string): StateGitGuardResult {
  if (!existsSync(join(stateDir, ".git"))) {
    return { gitRepository: false, removedHooksPath: null };
  }

  const hooksPath = gitConfigGet(stateDir, "core.hooksPath");
  if (hooksPath === null) {
    return { gitRepository: true, removedHooksPath: null };
  }

  execFileSync("git", ["config", "--unset", "core.hooksPath"], {
    cwd: stateDir,
    stdio: "ignore",
  });
  return { gitRepository: true, removedHooksPath: hooksPath };
}
