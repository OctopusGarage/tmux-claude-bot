import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  hasLoopExecutionQuarantine,
  listLoopExecutionQuarantines,
  quarantineLoopExecution,
} from "../../src/core/loop/execution-quarantine.js";
import * as processRunner from "../../src/core/loop/ralph-process.js";
import { executeRalphTask } from "../../src/core/loop/ralph-task.js";
import { buildLoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalToken = process.env.GH_TOKEN;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalToken;
});

function fixture(commands: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tcb-preflight-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { stdio: "ignore" },
  );
  const config = parseLoopConfigYaml(
    JSON.stringify({
      projects: [
        {
          id: "preflight",
          name: "Preflight",
          path: repo,
          agent: "codex",
          goal: "Inspect one seam",
          maxRounds: 1,
          targetScore: 90,
          runner: { kind: "agent-supervised" },
          execution: { agent: true, architecture: { kind: "ralphworks" } },
          assessment: { command: "true" },
        },
      ],
    }),
  );
  const project = config.projects[0];
  if (!project) throw new Error("missing fixture project");
  const workOrder = buildLoopWorkOrder({
    config,
    project,
    runId: "preflight-run",
    scheduledAt: Date.now(),
  });
  workOrder.finalSummaryPath = join(root, "artifacts", "supervisor-final-summary.json");
  workOrder.preflight.commands = commands;
  const attempt = join(root, "artifacts", "architecture-execution");
  const cli = join(root, "must-not-launch");
  const run = () =>
    executeRalphTask({ workOrder, timeoutMs: 5000, signal: new AbortController().signal }, cli);
  return { root, workOrder, attempt, cli, run };
}

describe("external task preflight failures", () => {
  it("preserves bounded redacted command evidence and releases proven prelaunch ownership", async () => {
    process.env.GH_TOKEN = "sensitive-fixture-token";
    const command = `node -e 'process.stdout.write("x".repeat(9000)); process.stderr.write("ERR_PNPM_NO_OFFLINE_TARBALL password=inline-secret " + process.env.GH_TOKEN); process.exit(7)'`;
    const f = fixture(["true", command, "exit 99"]);
    quarantineLoopExecution(
      { ...f.workOrder, id: "older-quarantine", projectPath: join(f.root, "older-worktree") },
      "previous ownership uncertainty",
    );
    const older = listLoopExecutionQuarantines().find(
      (record) => record.workOrderId === "older-quarantine",
    );
    const runner = vi.spyOn(processRunner, "runRalphProcess");
    await expect(f.run()).rejects.toThrow(
      "RalphWorks preflight command 2 failed (exit 7); see preflight-failure.json",
    );
    const path = join(f.attempt, "preflight-failure.json");
    const raw = readFileSync(path, "utf8");
    const diagnostic = JSON.parse(raw);
    expect(diagnostic).toMatchObject({
      schemaVersion: 1,
      commandIndex: 2,
      commandCount: 3,
      commandSha256: createHash("sha256").update(command).digest("hex"),
      exitStatus: 7,
      implementationStarted: false,
      knownProcessesStopped: true,
    });
    expect(diagnostic.stderr).toContain("ERR_PNPM_NO_OFFLINE_TARBALL");
    expect(diagnostic.stdout.length).toBeLessThanOrEqual(4096);
    expect(diagnostic.stderr.length).toBeLessThanOrEqual(4096);
    expect(raw).not.toContain("sensitive-fixture-token");
    expect(raw).not.toContain("inline-secret");
    expect(raw).not.toContain(command);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(false);
    expect(
      listLoopExecutionQuarantines().find((record) => record.workOrderId === "older-quarantine"),
    ).toEqual(older);
    expect(existsSync(join(f.attempt, "reservation.json"))).toBe(true);
    expect(existsSync(join(f.attempt, "receipt.json"))).toBe(false);
    expect(
      runner.mock.calls.some(
        ([input]) => input.executable === f.cli || input.args.includes("exit 99"),
      ),
    ).toBe(false);
  });

  it.each(["cancelled", "timed_out"] as const)(
    "releases a positively stopped preflight without fabricating a receipt: %s",
    async (reason) => {
      const f = fixture(["fixture-preflight"]);
      const actual = processRunner.runRalphProcess;
      const runner = vi.spyOn(processRunner, "runRalphProcess").mockImplementation(async (input) =>
        input.executable === "sh"
          ? {
              status: 0,
              stdout: "",
              stderr: "",
              stopped: { reason, knownProcessesStopped: true },
            }
          : actual(input),
      );
      await expect(f.run()).rejects.toMatchObject({ reason, receiptReconciled: false });
      expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(false);
      expect(
        JSON.parse(readFileSync(join(f.attempt, "preflight-failure.json"), "utf8")),
      ).toMatchObject({
        stopReason: reason,
        implementationStarted: false,
        knownProcessesStopped: true,
      });
      expect(existsSync(join(f.attempt, "receipt.json"))).toBe(false);
      expect(runner.mock.calls.some(([input]) => input.executable === f.cli)).toBe(false);
    },
  );

  it.each(["process-probe", "ownership-persistence", "untyped"] as const)(
    "retains quarantine after unproven %s failure",
    async (stage) => {
      const f = fixture(["fixture-preflight"]);
      const actual = processRunner.runRalphProcess;
      const error =
        stage === "untyped"
          ? new Error("unknown stop outcome")
          : new processRunner.RalphProcessOwnershipError("ownership unproven", {
              stage,
              errorName: "Error",
              code: null,
              killed: null,
              signal: null,
              elapsedMs: 1,
            });
      const runner = vi
        .spyOn(processRunner, "runRalphProcess")
        .mockImplementation(async (input) => {
          if (input.executable === "sh") throw error;
          return actual(input);
        });
      await expect(f.run()).rejects.toBe(error);
      expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(true);
      expect(existsSync(join(f.attempt, "preflight-failure.json"))).toBe(false);
      expect(runner.mock.calls.some(([input]) => input.executable === f.cli)).toBe(false);
    },
  );
});
