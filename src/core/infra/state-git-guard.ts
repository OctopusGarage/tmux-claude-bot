import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type StateGitGuardResult = {
  gitRepository: boolean;
  removedHooksPath: string | null;
  contaminatedInstallRootGitRepository?: boolean;
  removedInstallRootHooksPath?: string | null;
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
  const result: StateGitGuardResult = { gitRepository: false, removedHooksPath: null };

  if (existsSync(join(stateDir, ".git"))) {
    result.gitRepository = true;
    result.removedHooksPath = unsetHooksPath(stateDir);
  }

  const installRoot = dirname(stateDir);
  if (basename(stateDir) === "state" && contaminatedInstallRootStateRepository(installRoot)) {
    result.contaminatedInstallRootGitRepository = true;
    result.removedInstallRootHooksPath = unsetHooksPath(installRoot);
  }

  return result;
}

function unsetHooksPath(cwd: string): string | null {
  const hooksPath = gitConfigGet(cwd, "core.hooksPath");
  if (hooksPath === null) {
    return null;
  }

  execFileSync("git", ["config", "--unset", "core.hooksPath"], {
    cwd,
    stdio: "ignore",
  });
  return hooksPath;
}

function gitTracksPath(cwd: string, path: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", path], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function contaminatedInstallRootStateRepository(installRoot: string): boolean {
  if (!existsSync(join(installRoot, ".git"))) return false;
  const tracksState = gitTracksPath(installRoot, "state/loop_backlog.json");
  const tracksSource =
    gitTracksPath(installRoot, "src/cli.ts") || gitTracksPath(installRoot, "package.json");
  return tracksState && tracksSource;
}
