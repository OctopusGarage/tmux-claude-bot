import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import { quarantineLoopExecution } from "../../src/core/loop/execution-quarantine.js";
import { LoopSchedulerStore } from "../../src/core/loop/scheduler.js";
import { runGitCommand, runLoopServiceTickAsync } from "../../src/core/loop/service.js";
import {
  runLoopSupervisedProjectAsync,
  type SupervisorDispatchRequest,
} from "../../src/core/loop/supervised-runner.js";
import { buildLoopWorkOrder } from "../../src/core/loop/work-order.js";

const originalPath = process.env.PATH;
const originalState = process.env.TCB_STATE_DIR;
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalState === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalState;
  vi.restoreAllMocks();
});

function fixture(badReceipt = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tcb-ralph-review-recovery-")));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  process.env.TCB_STATE_DIR = join(dir, "state");
  process.env.PATH = `${bin}:${originalPath}`;
  const attempts = join(dir, "attempts.log");
  const cli = join(bin, "ralph");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1],hash=x=>crypto.createHash('sha256').update(x).digest('hex');
fs.appendFileSync(${JSON.stringify(attempts)},'attempt\\n');
const runDir=path.join(arg('--state-dir'),'runs/fixture');fs.mkdirSync(runDir,{recursive:true});
const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
fs.writeFileSync('ARCHITECTURE_REPORT.md','Bounded fixture plan and baseline evidence.\\n');
const checks=[];for(let i=0;i<args.length;i++)if(args[i]==='--check'){const command=args[++i],r=cp.spawnSync('sh',['-lc',command],{encoding:'utf8'});checks.push({iteration:1,command,exitCode:${badReceipt ? "1" : "r.status"},stdout:r.stdout,stderr:r.stderr});}
checks.push({iteration:1,command:'output: ARCHITECTURE_REPORT.md',exitCode:0,stdout:'',stderr:''});
const result={jobName:'fixture',status:'completed',iterations:1,runDir,eventsPath:path.join(runDir,'events.jsonl'),resultPath:path.join(runDir,'result.json'),checks,costUsd:0,commits:[]};
fs.writeFileSync(result.eventsPath,'{}\\n');fs.writeFileSync(result.resultPath,JSON.stringify(result));
fs.writeFileSync(arg('--result-file'),JSON.stringify({schemaVersion:1,invocationId:arg('--invocation-id'),startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),workspace:{path:process.cwd(),baseHead:head,head},taskInputSha256:hash(fs.readFileSync(args[1])),profile:{name:'architecture',fingerprint:hash('fixture')},result,outputs:[{path:'ARCHITECTURE_REPORT.md',required:true,format:'text',sha256:hash(fs.readFileSync('ARCHITECTURE_REPORT.md'))}]}));
`,
  );
  chmodSync(cli, 0o755);
  const configFile = join(dir, "loop.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      scheduler: { jitter: { enabled: false } },
      projects: [
        {
          id: "fixture",
          name: "Fixture",
          path: repo,
          agent: "codex",
          schedule: "*/5 * * * *",
          worktreeIsolation: "source",
          goal: "Review one architecture seam.",
          maxRounds: 1,
          targetScore: 90,
          runner: { kind: "agent-supervised", timeoutMs: 5000 },
          assessment: { command: "printf fixture" },
          eval: { command: "printf fixture", minScore: 90 },
          execution: { agent: true, architecture: { kind: "ralphworks" } },
          commit: { enabled: true },
          pullRequest: { enabled: false },
        },
      ],
    }),
  );
  return { dir, repo, attempts, configFile, git };
}

async function tick(
  f: ReturnType<typeof fixture>,
  dispatch: (
    request: SupervisorDispatchRequest,
  ) => Promise<{ status: number; stdout: string; stderr: string }>,
  recover?: () => Promise<boolean>,
  evaluation?: () => { status: number; stdout: string; stderr: string },
) {
  return runLoopServiceTickAsync({
    configFile: f.configFile,
    now: Date.parse("2026-07-16T10:10:00Z"),
    schedulerStore: new LoopSchedulerStore(),
    supervisorSessionName: "fixture-supervisor",
    ensureSupervisorSession: recover ?? (async () => true), // The disposable fixture has no remote; only transport sync is a no-op.
    runGit: (invocation) =>
      ["fetch", "pull"].includes(invocation.args[0] ?? "")
        ? { status: 0, stdout: "", stderr: "" }
        : runGitCommand(invocation),
    runCommand: ({ kind }) =>
      kind === "eval" && evaluation
        ? evaluation()
        : {
            status: 0,
            stdout: JSON.stringify(
              kind === "assessment"
                ? {
                    score: 10,
                    findings: [
                      {
                        id: "seam",
                        summary: "Reduce parser coupling",
                        affectedFiles: ["source.ts"],
                      },
                    ],
                  }
                : { passed: true, score: 95 },
            ),
            stderr: "",
          },
    runSupervisorTask: dispatch,
  });
}

function complete(f: ReturnType<typeof fixture>, request: SupervisorDispatchRequest) {
  f.git(["add", "ARCHITECTURE_REPORT.md"]);
  f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "test: reviewed fixture",
  ]);
  return {
    status: 0,
    stdout: `${request.workOrder.requiredFinalMarker}\n${JSON.stringify({ status: "completed", projectId: "fixture", actionsTaken: ["reviewed fixture"], delegatedTasks: [], finalVerification: "passed", commits: [f.git(["rev-parse", "HEAD"]).trim()], followUps: [] })}`,
    stderr: "",
  };
}

describe("RalphWorks service review readiness recovery", () => {
  it("retries only review after readiness recovery, with one external attempt and the same deadline", async () => {
    const f = fixture();
    const requests: SupervisorDispatchRequest[] = [];
    let recoveries = 0;
    const recover = vi.fn(async () => {
      recoveries++;
      return true;
    });
    const result = await tick(
      f,
      async (request) => {
        requests.push(request);
        if (requests.length === 1)
          return { status: 1, stdout: "", stderr: "Codex did not become ready in time" };
        return complete(f, request);
      },
      recover,
    );
    expect(result.failed).toBe(0);
    expect(requests).toHaveLength(2);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
    expect(recoveries).toBe(2);
    const deadline = (request: SupervisorDispatchRequest | undefined) => {
      const value = request?.prompt.match(/Review hard deadline \(UTC\): ([^\n]+)/)?.[1];
      if (value === undefined) throw new Error("missing original review deadline");
      return value;
    };
    expect(deadline(requests[1])).toBe(deadline(requests[0]));
    const originalTimeout = requests[0]?.timeoutMs;
    if (originalTimeout === undefined) throw new Error("missing original review timeout");
    expect(requests[1]?.timeoutMs).toBeLessThanOrEqual(originalTimeout);
  });

  it("does not recover readiness for a valid summary mentioning startup failure", async () => {
    const f = fixture();
    const recover = vi.fn(async () => true);
    const result = await tick(
      f,
      async (request) => {
        const response = complete(f, request);
        response.stdout = response.stdout.replace(
          "reviewed fixture",
          "Codex did not become ready in time; reviewed fixture",
        );
        return response;
      },
      recover,
    );
    expect(result.failed).toBe(0);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not retry review after cancellation during readiness recovery", async () => {
    const f = fixture();
    const controller = new AbortController();
    let dispatches = 0;
    const config = parseLoopConfigYaml(readFileSync(f.configFile, "utf8"));
    const project = config.projects[0];
    if (!project) throw new Error("missing fixture project");
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: Date.now(),
      runId: "cancel-review",
    });
    const result = await runLoopSupervisedProjectAsync({
      workOrder,
      supervisorSession: "fixture-supervisor",
      timeoutMs: 5000,
      cancelSignal: controller.signal,
      dispatch: async () => {
        dispatches++;
        return { status: 1, stdout: "", stderr: "Codex did not become ready in time" };
      },
      recoverDispatchReadiness: async () => {
        controller.abort("fixture cancellation");
        return true;
      },
    });
    expect(result.status).toBe("cancelled");
    expect(dispatches).toBe(1);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not recover readiness after the original deadline expires", async () => {
    const f = fixture();
    let dispatches = 0;
    const recover = vi.fn(async () => true);
    const result = await tick(
      f,
      async () => {
        dispatches++;
        const expired = Date.now() + 6000;
        vi.spyOn(Date, "now").mockReturnValue(expired);
        return { status: 1, stdout: "", stderr: "Codex did not become ready in time" };
      },
      recover,
    );
    expect(result.failed).toBe(1);
    expect(dispatches).toBe(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("keeps the original deadline across system-gate review revisions", async () => {
    const f = fixture();
    const requests: SupervisorDispatchRequest[] = [];
    let now = 0;
    const result = await tick(
      f,
      async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          now = Date.now();
          vi.spyOn(Date, "now").mockImplementation(() => now);
          return complete(f, request);
        }
        return {
          status: 0,
          stdout: `${request.workOrder.requiredFinalMarker}\n${JSON.stringify({ status: "blocked", projectId: "fixture", actionsTaken: ["reviewed failed gate"], delegatedTasks: [], finalVerification: "failed", commits: [], followUps: [] })}`,
          stderr: "",
        };
      },
      undefined,
      () => {
        now += 1000;
        return { status: 1, stdout: '{"passed":false,"score":10}', stderr: "fixture gate failed" };
      },
    );
    expect(result.failed).toBe(1);
    expect(requests).toHaveLength(2);
    const deadline = (request: SupervisorDispatchRequest | undefined) => {
      const value = request?.prompt.match(/Review hard deadline \(UTC\): ([^\n]+)/)?.[1];
      if (value === undefined) throw new Error("missing original review deadline");
      return value;
    };
    expect(deadline(requests[1])).toBe(deadline(requests[0]));
    const originalTimeout = requests[0]?.timeoutMs;
    if (originalTimeout === undefined) throw new Error("missing original review timeout");
    expect(requests[1]?.timeoutMs).toBeLessThanOrEqual(originalTimeout - 1000);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not retry review when readiness recovery exhausts the deadline", async () => {
    const f = fixture();
    let dispatches = 0;
    let ensures = 0;
    const recover = async () => {
      ensures++;
      if (ensures === 2) vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
      return true;
    };
    const result = await tick(
      f,
      async () => {
        dispatches++;
        return { status: 1, stdout: "", stderr: "Codex did not become ready in time" };
      },
      recover,
    );
    expect(result.failed).toBe(1);
    expect(dispatches).toBe(1);
    expect(ensures).toBe(2);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not start the production gate after review consumes the shared deadline", async () => {
    const f = fixture();
    const evaluation = vi.fn(() => ({
      status: 0,
      stdout: '{"passed":true,"score":95}',
      stderr: "",
    }));
    const result = await tick(
      f,
      async (request) => {
        const response = complete(f, request);
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
        return response;
      },
      undefined,
      evaluation,
    );
    expect(result.failed).toBe(1);
    expect(evaluation).not.toHaveBeenCalled();
  });

  it("rejects gate success returned after the original deadline", async () => {
    const f = fixture();
    let dispatches = 0;
    const evaluation = vi.fn(() => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
      return { status: 0, stdout: '{"passed":true,"score":95}', stderr: "" };
    });
    const result = await tick(
      f,
      async (request) => {
        dispatches++;
        return complete(f, request);
      },
      undefined,
      evaluation,
    );
    expect(result.failed).toBe(1);
    expect(evaluation).toHaveBeenCalledTimes(1);
    expect(dispatches).toBe(1);
  });

  it("does not grant a fresh revision after the system gate exhausts the deadline", async () => {
    const f = fixture();
    let dispatches = 0;
    const result = await tick(
      f,
      async (request) => {
        dispatches++;
        return complete(f, request);
      },
      undefined,
      () => {
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
        return { status: 1, stdout: '{"passed":false,"score":10}', stderr: "fixture gate timeout" };
      },
    );
    expect(result.failed).toBe(1);
    expect(dispatches).toBe(1);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not revise review while execution ownership is quarantined", async () => {
    const f = fixture();
    let dispatches = 0;
    let active: SupervisorDispatchRequest | undefined;
    const result = await tick(
      f,
      async (request) => {
        active = request;
        dispatches++;
        return complete(f, request);
      },
      undefined,
      () => {
        if (!active) throw new Error("missing fixture request");
        quarantineLoopExecution(active.workOrder, "Fixture ownership unresolved after gate");
        return { status: 1, stdout: '{"passed":false,"score":10}', stderr: "fixture failed" };
      },
    );
    expect(result.failed).toBe(1);
    expect(dispatches).toBe(1);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("bounds readiness recovery to one attempt", async () => {
    const f = fixture();
    let dispatches = 0;
    const recover = vi.fn(async () => true);
    const result = await tick(
      f,
      async () => {
        dispatches++;
        return { status: 1, stdout: "", stderr: "Codex did not become ready in time" };
      },
      recover,
    );
    expect(result.failed).toBe(1);
    expect(dispatches).toBe(2);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it.each(["receipt", "quarantine"] as const)(
    "refuses review recovery after %s evidence becomes unsafe",
    async (fault) => {
      const f = fixture();
      let dispatches = 0;
      const result = await tick(f, async (request) => {
        dispatches++;
        const summaryPath = request.workOrder.finalSummaryPath;
        if (summaryPath === undefined) throw new Error("missing fixture summary path");
        if (fault === "receipt")
          writeFileSync(join(dirname(summaryPath), "architecture-execution", "receipt.json"), "{}");
        else quarantineLoopExecution(request.workOrder, "Fixture ownership unresolved");
        return { status: 1, stdout: "", stderr: "Codex did not become ready in time" };
      });
      expect(result.failed).toBe(1);
      expect(dispatches).toBe(1);
      expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
    },
  );

  it.each(["output", "quarantine"] as const)(
    "refuses a second review when %s changes inside successful readiness recovery",
    async (fault) => {
      const f = fixture();
      let active: SupervisorDispatchRequest | undefined;
      let dispatches = 0;
      let mutations = 0;
      const recover = vi.fn(async () => {
        if (active !== undefined) {
          mutations++;
          if (fault === "output")
            writeFileSync(
              join(f.repo, "ARCHITECTURE_REPORT.md"),
              "Changed after receipt acceptance",
            );
          else
            quarantineLoopExecution(active.workOrder, "Fixture ownership changed during recovery");
        }
        return true;
      });
      const result = await tick(
        f,
        async (request) => {
          active = request;
          dispatches++;
          return { status: 1, stdout: "", stderr: "Codex did not become ready in time" };
        },
        recover,
      );
      expect(result.failed).toBe(1);
      expect(recover).toHaveBeenCalledTimes(2);
      expect(mutations).toBe(1);
      expect(dispatches).toBe(1);
      expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
    },
  );

  it("never dispatches review or retries implementation after a rejected receipt", async () => {
    const f = fixture(true);
    const dispatch = vi.fn(async () => ({ status: 1, stdout: "", stderr: "must not run" }));
    const result = await tick(f, dispatch);
    expect(result.failed).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(readFileSync(f.attempts, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
