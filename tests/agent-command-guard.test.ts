import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/agent-command-guard.sh");

function runGuard(command: string, toolName = "Bash") {
  const result = spawnSync("sh", [script], {
    input: JSON.stringify({
      tool_name: toolName,
      tool_input: { command },
    }),
    encoding: "utf8",
  });
  return result;
}

describe("agent command guard", () => {
  it("blocks attempts to set core.bare=true through git config", () => {
    const result = runGuard("git --git-dir=.git config core.bare true");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("core.bare=true");
  });

  it("blocks direct writes that would make .git/config bare", () => {
    const result = runGuard('printf "bare = true\\n" >> .git/config');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(".git/config");
  });

  it("allows recovery and read-only core.bare commands", () => {
    expect(runGuard("git config --local core.bare false").status).toBe(0);
    expect(runGuard("git config --get core.bare").status).toBe(0);
    expect(runGuard("grep 'bare = true' .git/config").status).toBe(0);
  });

  it("ignores non-shell tool events", () => {
    expect(runGuard("git config core.bare true", "Read").status).toBe(0);
  });
});
