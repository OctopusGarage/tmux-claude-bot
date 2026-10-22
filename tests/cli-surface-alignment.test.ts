import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

function cliHelp(args: string[] = [], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, NODE_NO_WARNINGS: "1" },
  });
}

function commandNames(help: string): string[] {
  const commands = help.split("\nCommands:\n")[1] ?? "";
  return [...commands.matchAll(/^ {2}([a-z][a-z0-9:-]*)\b/gm)]
    .map((match) => match[1] as string)
    .filter((command) => command !== "help")
    .sort();
}

describe("CLI surface alignment", () => {
  it("keeps the top-level CLI reference equal to executable Commander help", () => {
    const documentedSection = read("docs/cli-reference.md").split("## Nested Commands")[0] ?? "";
    const documented = [...documentedSection.matchAll(/^- `tcb ([a-z][a-z0-9:-]*)\b/gm)]
      .map((match) => match[1] as string)
      .sort();

    expect(documented).toEqual(commandNames(cliHelp()));
  });

  it("tildeifies the managed directory in executable CLI help", () => {
    const managedDir = path.join(homedir(), ".tmux-cli-help-contract");
    const help = cliHelp([], { ...process.env, TMUX_CLAUDE_BOT_DIR: managedDir });

    expect(help).toContain("~/.tmux-cli-help-contract");
    expect(help).not.toContain(homedir());
  });

  it("advertises Resource Guardian through the existing sysload command", () => {
    expect(cliHelp()).toMatch(/^ {2}sysload\s+.*Resource Guardian$/m);
  });

  it("does not advertise the retired Batch Scheduler", () => {
    expect(commandNames(cliHelp())).not.toContain("batch");
    expect(read("docs/cli-reference.md")).not.toContain("tcb batch");
    expect(read("scripts/smoke.sh")).not.toMatch(/^\s*batch\s*\\?$/m);
  });

  it("keeps Home Operator service recipes within the executable service command set", () => {
    const supported = new Set(commandNames(cliHelp(["service"])));
    const skill = read("skills/tcb-home-operator/SKILL.md");
    const documented = [...skill.matchAll(/`tcb service ([a-z-]+)\b/g)].map(
      (match) => match[1] as string,
    );

    expect(documented.length).toBeGreaterThan(0);
    for (const action of documented) {
      expect(supported, `unsupported Home Operator service action: ${action}`).toContain(action);
    }
  });
});
