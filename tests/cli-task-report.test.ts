import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TCB_STATE_DIR: mkdtempSync(join(tmpdir(), "tcb-task-report-cli-")),
    },
    encoding: "utf8",
  });
}

describe("CLI task report command", () => {
  it("accepts autopilot-delegate and advertises it in source help", () => {
    const result = runCli([
      "task",
      "report",
      "--id",
      "autopilot:1785952192073",
      "--source",
      "autopilot-delegate",
      "--name",
      "autopilot delegated task",
      "--scheduled-at",
      "2026-08-06T02:00:00Z",
      "--status",
      "failed",
      "--repair-status",
      "fixed",
      "--summary",
      "final-summary parser defect was fixed in PR #104",
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      taskId: "autopilot:1785952192073",
    });

    const help = runCli(["task", "report", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("autopilot-delegate");
  });
});
