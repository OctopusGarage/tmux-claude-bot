import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import { runRalphProcess } from "../../src/core/loop/ralph-process.js";
import { executeRalphTask } from "../../src/core/loop/ralph-task.js";
import { TASK_IMPLEMENTATIONS } from "../../src/core/loop/task-implementation.js";
import { buildLoopWorkOrder } from "../../src/core/loop/work-order.js";

vi.mock("../../src/core/loop/ralph-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/core/loop/ralph-process.js")>()),
  runRalphProcess: vi.fn(),
}));

it.each(["architecture", "bug-fix", "test-coverage", "security-maintenance"] as const)(
  "%s launches no further command after final source observation reports timeout",
  async (kind) => {
    const metadata = TASK_IMPLEMENTATIONS[kind];
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tcb-deadline-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    const config = parseLoopConfigYaml(`projects:
  - id: fixture
    name: Fixture
    path: ${repo}
    agent: codex
    goal: Reduce coupling.
    maxRounds: 1
    targetScore: 90
    assessment: {command: "printf assessment"}
    execution: {agent: true, ${metadata.configKey}: {kind: ralphworks}}
    runner: {kind: agent-supervised}
`);
    const project = config.projects[0];
    if (project === undefined) throw new Error("missing fixture");
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      jobKind: kind,
      runId: "deadline-run",
      scheduledAt: Date.now(),
    });
    workOrder.finalSummaryPath = join(root, "artifacts/final.json");
    const head = "a".repeat(40);
    const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
    let externalFinished = false;
    const afterExternal: string[][] = [];
    vi.mocked(runRalphProcess).mockImplementation(async (invocation) => {
      if (invocation.executable === "ralph") {
        const args = invocation.args;
        const arg = (name: string) => args[args.indexOf(name) + 1] ?? "";
        const runDir = join(arg("--state-dir"), "runs/fixture");
        mkdirSync(runDir, { recursive: true });
        const report = "Bounded baseline, plan, and verification evidence.\n";
        writeFileSync(join(repo, metadata.report), report);
        const result = {
          jobName: "fixture",
          status: "completed",
          iterations: 1,
          runDir,
          eventsPath: join(runDir, "events.jsonl"),
          resultPath: join(runDir, "result.json"),
          checks: [
            { iteration: 1, command: "printf assessment", exitCode: 0, stdout: "", stderr: "" },
            {
              iteration: 1,
              command: `output: ${metadata.report}`,
              exitCode: 0,
              stdout: "",
              stderr: "",
            },
          ],
          costUsd: 0,
          commits: [],
        };
        writeFileSync(result.eventsPath, "{}\n");
        writeFileSync(result.resultPath, JSON.stringify(result));
        const receipt = {
          schemaVersion: 1,
          invocationId: arg("--invocation-id"),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          workspace: { path: repo, baseHead: head, head },
          taskInputSha256: hash(readFileSync(args[1] ?? "")),
          profile: { name: metadata.label, fingerprint: hash("profile") },
          result,
          outputs: [
            { path: metadata.report, required: true, format: "text", sha256: hash(report) },
          ],
        };
        writeFileSync(arg("--result-file"), JSON.stringify(receipt));
        externalFinished = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (externalFinished) {
        afterExternal.push(invocation.args);
        if (afterExternal.length === 1)
          return {
            status: 124,
            stdout: "",
            stderr: "timed out",
            stopped: { reason: "timed_out", knownProcessesStopped: true },
          };
      }
      const args = invocation.args.join(" ");
      return {
        status: 0,
        stdout: args.includes("--show-toplevel")
          ? repo
          : args === "rev-parse HEAD"
            ? head
            : args.includes("symbolic-ref")
              ? "main"
              : "",
        stderr: "",
      };
    });
    await expect(
      executeRalphTask({ workOrder, timeoutMs: 10000, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ reason: "timed_out", receiptReconciled: true });
    expect(afterExternal).toEqual([["rev-parse", "--show-toplevel"]]);
  },
);
