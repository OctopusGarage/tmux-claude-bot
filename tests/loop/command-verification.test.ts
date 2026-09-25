import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  runSupervisedSystemGateOutcome,
  systemGateProjectFromWorkOrder,
} from "../../src/core/loop/service.js";
import { buildLoopWorkOrder } from "../../src/core/loop/work-order.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tcb-command-verification-"));
  const config = parseLoopConfigYaml(`
projects:
  - id: app
    name: App
    path: /repo/app
    agent: codex
    runner: { kind: agent-supervised }
    goal: Verify the authorized task.
    maxRounds: 1
    targetScore: 90
    assessment: { command: pnpm assess }
    eval: { command: node verify.cjs, minScore: 90 }
    execution: { agent: true }
`);
  const project = config.projects[0];
  if (!project) throw new Error("missing project");
  const workOrder = {
    ...buildLoopWorkOrder({ config, project, scheduledAt: 1, runId: "command-test" }),
    finalSummaryPath: join(dir, "final.json"),
  };
  const head = "a".repeat(40);
  const runGit = vi.fn(({ args }: { args: string[] }) => ({
    status: 0,
    stdout: args.includes("--show-toplevel")
      ? "/repo/app\n"
      : args.includes("HEAD")
        ? `${head}\n`
        : "",
    stderr: "",
  }));
  const runCommand = vi.fn(() => ({ status: 0, stdout: '{"passed":true,"score":95}', stderr: "" }));
  const input = {
    workOrder,
    project: systemGateProjectFromWorkOrder(workOrder),
    runGit,
    runCommand,
    result: {
      status: "completed" as const,
      output: "agent says passed",
      summary: {
        status: "completed" as const,
        projectId: "app",
        actionsTaken: [],
        delegatedTasks: [],
        finalVerification: "passed" as const,
        commits: [],
        followUps: [],
      },
    },
  };
  return { dir, head, input, runGit, runCommand };
}

describe("system command verification", () => {
  it("runs only the configured evaluation and records revision-bound system evidence", () => {
    const f = fixture();
    const gate = runSupervisedSystemGateOutcome(f.input);
    expect(gate.result.status).toBe("completed");
    expect(f.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "eval", cwd: "/repo/app", command: "node verify.cjs" }),
    );
    const artifacts = readdirSync(join(f.dir, "command-verifications"));
    expect(artifacts).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(f.dir, "command-verifications", artifacts[0] ?? ""), "utf8"),
    );
    expect(record).toMatchObject({
      source: "system-command",
      revision: f.head,
      passed: true,
      exitStatus: 0,
    });
    expect(record.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.startedAt).toEqual(expect.any(String));
    expect(record.endedAt).toEqual(expect.any(String));
    expect(record.outputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("pins the bot state directory for independent verification commands", () => {
    const f = fixture();
    const previous = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = f.dir;
    try {
      runSupervisedSystemGateOutcome(f.input);
      expect(f.runCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({ TCB_STATE_DIR: f.dir }),
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.TCB_STATE_DIR;
      else process.env.TCB_STATE_DIR = previous;
    }
  });

  it.each([
    [1, '{"passed":true,"score":95}'],
    [0, '{"passed":false,"score":95}'],
    [0, '{"passed":true,"score":80}'],
    [0, "unstructured success"],
    [0, '{"passed":true,"score":1e400}'],
  ])("rejects agent success when system evaluation fails (%s, %s)", (status, stdout) => {
    const f = fixture();
    f.runCommand.mockReturnValue({ status, stdout, stderr: "" });
    expect(runSupervisedSystemGateOutcome(f.input).result.status).toBe("supervisor-failed");
    const files = readdirSync(join(f.dir, "command-verifications"));
    const record = JSON.parse(
      readFileSync(join(f.dir, "command-verifications", files[0] ?? ""), "utf8"),
    );
    expect(record.passed).toBe(false);
  });

  it.each(["root", "head", "status"])("rejects failed post-command %s observations", (fault) => {
    const f = fixture();
    f.runCommand.mockImplementation(() => {
      f.runGit.mockImplementation(({ args }) => {
        const kind = args.includes("--show-toplevel")
          ? "root"
          : args.includes("HEAD")
            ? "head"
            : "status";
        return {
          status: kind === fault ? 1 : 0,
          stdout: kind === "root" ? "/repo/app" : kind === "head" ? f.head : "",
          stderr: "observation failed",
        };
      });
      return { status: 0, stdout: '{"passed":true,"score":95}', stderr: "" };
    });
    expect(runSupervisedSystemGateOutcome(f.input).result.status).toBe("supervisor-failed");
  });

  it("blocks a wrong repository before executing the command", () => {
    const f = fixture();
    f.runGit.mockReturnValue({ status: 0, stdout: "/repo/other", stderr: "" });
    expect(runSupervisedSystemGateOutcome(f.input).result.status).toBe("supervisor-failed");
    expect(f.runCommand).not.toHaveBeenCalled();
  });

  it("rejects revision changes made during verification", () => {
    const f = fixture();
    f.runCommand.mockImplementation(() => {
      f.runGit.mockImplementation(({ args }) => ({
        status: 0,
        stdout: args.includes("--show-toplevel")
          ? "/repo/app"
          : args.includes("HEAD")
            ? "b".repeat(40)
            : "",
        stderr: "",
      }));
      return { status: 0, stdout: '{"passed":true,"score":95}', stderr: "" };
    });
    expect(runSupervisedSystemGateOutcome(f.input).result.status).toBe("supervisor-failed");
  });
});
