import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix = "tcb-ai-tools-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[], stateDir = tempDir(), home = tempDir("tcb-home-")) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, TCB_STATE_DIR: stateDir },
    encoding: "utf8",
  });
}

describe("CLI ai-tools command", () => {
  it("installs default operator-home skill and MCP surfaces without global skills", () => {
    const stateDir = tempDir();
    const home = tempDir("tcb-home-");
    const globalSkill = join(home, ".claude/skills/tcb-home-operator/SKILL.md");
    const legacyGlobal = join(home, ".codex/prompts/tmux-claude-bot.md");
    mkdirSync(join(home, ".claude/skills/tcb-home-operator"), { recursive: true });
    mkdirSync(join(home, ".codex/prompts"), { recursive: true });
    writeFileSync(globalSkill, "stale", { flag: "w" });
    writeFileSync(legacyGlobal, "legacy", { flag: "w" });

    const result = runCli(["ai-tools", "install", "--json"], stateDir, home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      operatorHome: string;
      removedGlobal: Array<{ removed: boolean }>;
      skills: Array<{ scope: string; tool: string; path: string }>;
      mcp: Array<{ profile: string; path: string }>;
    };
    expect(parsed.operatorHome).toBe(join(stateDir, "home"));
    expect(parsed.removedGlobal.filter((item) => item.removed).length).toBe(2);
    expect(parsed.skills.map((item) => `${item.scope}/${item.tool}`).sort()).toEqual([
      "operator-home/claude",
      "operator-home/codex",
    ]);
    expect(parsed.mcp.map((item) => item.profile).sort()).toEqual(["home", "observer"]);
    expect(existsSync(globalSkill)).toBe(false);
    expect(existsSync(legacyGlobal)).toBe(false);
    expect(existsSync(join(stateDir, "home/.claude/skills/tcb-home-operator/SKILL.md"))).toBe(true);
    expect(existsSync(join(stateDir, "home/.codex/prompts/tcb-home-operator.md"))).toBe(true);
    expect(existsSync(join(stateDir, "home/mcp/observer.json"))).toBe(true);
    expect(existsSync(join(stateDir, "home/mcp/home.json"))).toBe(true);
  });

  it("reports expected default surfaces and absent global skills", () => {
    const stateDir = tempDir();
    const home = tempDir("tcb-home-");
    expect(runCli(["ai-tools", "install"], stateDir, home).status).toBe(0);

    const result = runCli(["ai-tools", "status", "--json"], stateDir, home);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      expected: Array<{ surface: string; installed: boolean }>;
      global: Array<{ installed: boolean }>;
    };
    expect(parsed.expected).toHaveLength(4);
    expect(parsed.expected.every((item) => item.installed)).toBe(true);
    expect(parsed.global.every((item) => !item.installed)).toBe(true);
  });
});
