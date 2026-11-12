import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  hasLoopExecutionQuarantine,
  listLoopExecutionQuarantines,
} from "../../src/core/loop/execution-quarantine.js";
import { executeRalphTask, readRalphTaskEvidence } from "../../src/core/loop/ralph-task.js";
import { runSupervisedSystemGateOutcome } from "../../src/core/loop/service.js";
import { runLoopSupervisedProjectAsync } from "../../src/core/loop/supervised-runner.js";
import { buildLoopWorkOrder } from "../../src/core/loop/work-order.js";

const fixtureRoots: string[] = [];
function fixtureProcessIdentity(pid: number, root: string): string | null {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  try {
    const identity = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return identity.includes(root) ? identity : null;
  } catch {
    return null;
  }
}

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    const pids = ["detached.pid", "hang-ready.pid", "cancel-ready.pid", "root.pid"].flatMap(
      (name) =>
        existsSync(join(root, name)) ? [Number(readFileSync(join(root, name), "utf8"))] : [],
    );
    for (const pid of pids) {
      const identity = fixtureProcessIdentity(pid, root);
      if (identity === null || fixtureProcessIdentity(pid, root) !== identity) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    for (
      let attempt = 0;
      attempt < 50 && pids.some((pid) => fixtureProcessIdentity(pid, root) !== null);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (pids.some((pid) => fixtureProcessIdentity(pid, root) !== null))
      throw new Error("Owned fake CLI still running; fixture retained for inspection");
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(
  scenario = "completed",
  kind: "architecture" | "bug-fix" | "test-coverage" | "security-maintenance" = "architecture",
) {
  const dir = mkdtempSync(join(tmpdir(), "tcb-ralph-"));
  fixtureRoots.push(dir);
  const repo = join(dir, "repo with spaces");
  execFileSync("git", ["init", repo]);
  execFileSync("git", [
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
  ]);
  const config = parseLoopConfigYaml(`projects:
  - id: fixture
    name: Fixture
    path: ${repo}
    agent: codex
    goal: Reduce coupling in the parser.
    maxRounds: 2
    targetScore: 90
    runner: {kind: agent-supervised}
    execution: {agent: true, ${kind === "bug-fix" ? "bugFix" : kind === "test-coverage" ? "testCoverage" : kind === "security-maintenance" ? "securityMaintenance" : "architecture"}: {kind: ralphworks, params: {focus: parser}}}
    assessment: {command: "printf assessment"}
    allowedActions: [tests, docs, small-refactor]
`);
  const project = config.projects[0];
  if (project === undefined) throw new Error("missing fixture project");
  const workOrder = buildLoopWorkOrder({
    config,
    project,
    runId: "run-1",
    jobKind: kind,
    scheduledAt: Date.now(),
  });
  workOrder.finalSummaryPath = join(dir, "artifacts", "supervisor-final-summary.json");
  const cli = join(dir, "fake-ralph");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const cp = require('node:child_process');
const args = process.argv.slice(2); const arg = name => args[args.indexOf(name) + 1];
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(args));
fs.writeFileSync(${JSON.stringify(join(dir, "root.pid"))},String(process.pid));
const scenario = ${JSON.stringify(scenario)};
if(scenario === 'fast-detach') {const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",${JSON.stringify(dir)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(join(dir, "detached.pid"))},String(child.pid));child.unref();process.exit(0);}
const report = scenario === 'wrong-report' ? 'ARCHITECTURE_REPORT.md' : ${JSON.stringify(kind === "bug-fix" ? "BUGFIX_REPORT.md" : kind === "test-coverage" ? "COVERAGE_REPORT.md" : kind === "security-maintenance" ? "SECURITY_REPORT.md" : "ARCHITECTURE_REPORT.md")};
const publish = () => {
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const stateDir = path.resolve(args.includes('--state-dir') && scenario !== 'ignored-state-dir' ? arg('--state-dir') : '.ralph');
if (scenario === 'state-symlink') { const foreign = ${JSON.stringify(join(dir, "foreign-state"))}; fs.mkdirSync(foreign); fs.symlinkSync(foreign,stateDir); }
if (scenario === 'archive-collision') fs.mkdirSync(path.join(path.dirname(stateDir),'ralph-state'));
const runDir = path.join(stateDir,'runs/fixture'); fs.mkdirSync(runDir, {recursive:true});
if (scenario === 'workspace-walk') {
 fs.mkdirSync('.ralph/run.lock',{recursive:true});fs.writeFileSync('.ralph/run.lock/owner',process.pid+':fixture-uuid');
 fs.writeFileSync(path.join(stateDir,'input.json'),JSON.stringify({workspace:process.cwd(),taskFile:args[1]}));
}
const actualChecks = ['environment','workspace-walk'].includes(scenario) ? args.flatMap((v,i)=>v === '--check' ? [args[i+1]] : []).map(command=>{ const r=cp.spawnSync(command,{shell:true,cwd:process.cwd(),encoding:'utf8'});return {iteration:1,command,exitCode:r.status ?? 1,stdout:r.stdout,stderr:r.stderr}; }) : undefined;
const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
fs.writeFileSync(report, 'Plan and baseline evidence: inspect parser coupling, preserve scope, then run checks.\\n');
const result = {jobName:'fixture', status: scenario === 'failed' ? 'failed' : scenario.includes('cancel') && !scenario.startsWith('late-complete') ? 'cancelled' : 'completed', iterations:1, runDir, eventsPath:path.join(runDir,'events.jsonl'), resultPath:path.join(runDir,'result.json'), checks:[...(actualChecks ?? [{iteration:1,command:'printf assessment',exitCode: scenario === 'bad-check' ? 1 : 0,stdout:'assessment',stderr:''}]),{iteration:1,command:'output: '+report,exitCode:0,stdout:'',stderr:''}], costUsd:0,commits:[]};
if (scenario === 'max-iterations') { result.status='max_iterations';result.iterations=2;result.checks.push(...result.checks.map(check=>({...check,iteration:2}))); }
if (scenario === 'preflight-start') result.checks.unshift(...args.flatMap((value,index) => value === '--check' ? [{iteration:1,command:args[index+1],exitCode:0,stdout:'',stderr:''}] : []));
fs.writeFileSync(result.eventsPath, '{}\\n'); fs.writeFileSync(result.resultPath, JSON.stringify(result));
const receipt = {schemaVersion:1,invocationId:arg('--invocation-id'),startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),workspace:{path:process.cwd(),baseHead:head,head},taskInputSha256:hash(fs.readFileSync(args[1])),profile:{name:'architecture',fingerprint:hash('profile')},result,outputs:[{path:report,required:true,format:'text',sha256:hash(fs.readFileSync(report))}]};
if(scenario === 'foreign' || scenario === 'foreign-cancel') receipt.invocationId='other';
if(scenario === 'wrong-source') receipt.taskInputSha256=hash('other task');
if(scenario === 'wrong-head') receipt.workspace.head='a'.repeat(40);
if(scenario === 'wrong-path') receipt.result.resultPath='/outside/result.json';
if(scenario === 'missing-output') fs.unlinkSync('ARCHITECTURE_REPORT.md');
if(scenario === 'bad-output') fs.appendFileSync('ARCHITECTURE_REPORT.md','tampered');
if(scenario === 'cancelled-check') { receipt.result.checks[0].cancelled=true;fs.writeFileSync(result.resultPath,JSON.stringify(result)); }
if(scenario === 'bad-artifact') fs.writeFileSync(result.resultPath,'{}');
if(scenario !== 'no-receipt' && scenario !== 'no-cancel-receipt') fs.writeFileSync(arg('--result-file'), JSON.stringify(receipt));
process.exitCode = scenario === 'failed' ? 1 : 0;
};
if (scenario === 'hang') { const child=cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)',${JSON.stringify(dir)}], {stdio:'inherit'}); fs.writeFileSync(${JSON.stringify(join(dir, "hang-ready.pid"))},String(child.pid)); setInterval(()=>{},1000); }
else if (scenario.includes('cancel')) {
 const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",${JSON.stringify(dir)}],{detached:true,stdio:'ignore'});
 process.on('SIGTERM',()=>{if(scenario==='force-cancel')return;try{process.kill(child.pid,'SIGKILL');}catch{}publish();process.exit(0);});
 fs.writeFileSync(${JSON.stringify(join(dir, "cancel-ready.pid"))},String(child.pid));setInterval(()=>{},1000);
} else publish();
`,
  );
  chmodSync(cli, 0o755);
  return { dir, repo, workOrder, cli };
}

describe("RalphWorks architecture CLI boundary", () => {
  it.each(["architecture", "bug-fix", "test-coverage", "security-maintenance"] as const)(
    "keeps caller runtime state outside %s while original workspace checks walk every file",
    async (kind) => {
      const f = fixture("workspace-walk", kind);
      const scan =
        'const fs=require("node:fs"),p=require("node:path");if(!/^\\d+:[A-Za-z0-9-]+$/.test(fs.readFileSync(".ralph/run.lock/owner","utf8")))process.exit(2);function walk(d){for(const x of fs.readdirSync(d,{withFileTypes:true})){const n=p.join(d,x.name);if(x.isDirectory())walk(n);else if(fs.readFileSync(n).includes(Buffer.from(process.cwd())))process.exit(1)}}walk(process.cwd())';
      f.workOrder.assessment.command = `${JSON.stringify(process.execPath)} -e '${scan}'`;
      const evidence = await executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 10000, signal: new AbortController().signal },
        f.cli,
      );
      const attemptDir = join(
        f.dir,
        "artifacts",
        kind === "architecture" ? "architecture-execution" : "external-execution",
      );
      const statePath = join(realpathSync(attemptDir), "ralph-active-state");
      const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8")) as string[];
      expect(args[args.indexOf("--state-dir") + 1]).toBe(statePath);
      expect(JSON.parse(readFileSync(join(attemptDir, "reservation.json"), "utf8")).statePath).toBe(
        statePath,
      );
      const receipt = JSON.parse(readFileSync(evidence.receiptFile, "utf8"));
      expect(receipt.workspace.path).toBe(realpathSync(f.repo));
      expect(receipt.result.runDir).toBe(join(statePath, "runs", "fixture"));
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(join(evidence.archivePath, "input.json"))).toBe(true);
      expect(readRalphTaskEvidence(f.workOrder)).toMatchObject(evidence);
    },
  );

  it("accepts and preserves only an empty workspace lock parent", async () => {
    const f = fixture();
    mkdirSync(join(f.repo, ".ralph"));
    const evidence = await executeRalphTask(
      { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
      f.cli,
    );
    expect(readdirSync(join(f.repo, ".ralph"))).toEqual([]);
    expect(readRalphTaskEvidence(f.workOrder)).toMatchObject(evidence);
  });

  it.each(["contents", "lock", "file", "symlink"])(
    "preserves and rejects %s in legacy workspace state",
    async (kind) => {
      const f = fixture();
      writeFileSync(join(f.repo, ".git", "info", "exclude"), "\n.ralph\n", { flag: "a" });
      const state = join(f.repo, ".ralph");
      if (kind === "file") writeFileSync(state, "caller-owned");
      else if (kind === "symlink") {
        const outside = join(f.dir, "empty-state");
        mkdirSync(outside);
        symlinkSync(outside, state);
      } else {
        mkdirSync(state);
        if (kind === "lock") mkdirSync(join(state, "run.lock"));
        else writeFileSync(join(state, "progress.md"), "caller-owned");
      }
      await expect(
        executeRalphTask(
          { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
          f.cli,
        ),
      ).rejects.toThrow();
      expect(existsSync(state)).toBe(true);
      expect(existsSync(join(f.dir, "args.json"))).toBe(false);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "fails closed when existing workspace state cannot be read",
    async () => {
      const f = fixture();
      const state = join(f.repo, ".ralph");
      mkdirSync(state);
      writeFileSync(join(f.repo, ".git", "info", "exclude"), "\n.ralph\n", { flag: "a" });
      chmodSync(state, 0);
      try {
        await expect(
          executeRalphTask(
            { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
            f.cli,
          ),
        ).rejects.toThrow();
        expect(existsSync(join(f.dir, "args.json"))).toBe(false);
      } finally {
        chmodSync(state, 0o700);
      }
    },
  );

  it("refuses an existing archive instead of replacing it", async () => {
    const f = fixture("archive-collision");
    await expect(
      executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      ),
    ).rejects.toThrow(/archive/i);
  });

  it("revalidates historical default-state receipts without migrating task bytes", async () => {
    const f = fixture();
    const evidence = await executeRalphTask(
      { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
      f.cli,
    );
    const attempt = join(f.dir, "artifacts", "architecture-execution");
    const reservation = JSON.parse(readFileSync(join(attempt, "reservation.json"), "utf8"));
    const accepted = JSON.parse(readFileSync(join(attempt, "accepted-receipt.json"), "utf8"));
    const receipt = JSON.parse(readFileSync(evidence.receiptFile, "utf8"));
    const currentState = reservation.statePath as string;
    expect(currentState).toBe(join(realpathSync(attempt), "ralph-active-state"));
    const legacyState = join(realpathSync(f.repo), ".ralph");
    for (const key of ["runDir", "eventsPath", "resultPath"])
      receipt.result[key] = join(legacyState, relative(currentState, receipt.result[key]));
    writeFileSync(
      join(evidence.archivePath, relative(legacyState, receipt.result.resultPath)),
      JSON.stringify(receipt.result),
    );
    const receiptBytes = JSON.stringify(receipt);
    writeFileSync(evidence.receiptFile, receiptBytes);
    delete reservation.statePath;
    accepted.originalStatePath = legacyState;
    accepted.receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
    writeFileSync(join(attempt, "reservation.json"), JSON.stringify(reservation));
    writeFileSync(join(attempt, "accepted-receipt.json"), JSON.stringify(accepted));
    expect(readRalphTaskEvidence(f.workOrder)).toMatchObject({
      invocationId: evidence.invocationId,
      taskInputSha256: evidence.taskInputSha256,
      originalStatePath: legacyState,
    });
  });

  it.each(["missing", "foreign", "null", "accepted"])(
    "rejects %s external state correlation",
    async (change) => {
      const f = fixture();
      await executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      );
      const attempt = join(f.dir, "artifacts", "architecture-execution");
      const reservation = JSON.parse(readFileSync(join(attempt, "reservation.json"), "utf8"));
      const accepted = JSON.parse(readFileSync(join(attempt, "accepted-receipt.json"), "utf8"));
      if (change === "missing") delete reservation.statePath;
      if (change === "foreign") reservation.statePath = join(f.dir, "foreign-state");
      if (change === "null") reservation.statePath = null;
      if (change === "accepted") accepted.originalStatePath = join(realpathSync(f.repo), ".ralph");
      writeFileSync(join(attempt, "reservation.json"), JSON.stringify(reservation));
      writeFileSync(join(attempt, "accepted-receipt.json"), JSON.stringify(accepted));
      expect(() => readRalphTaskEvidence(f.workOrder)).toThrow();
    },
  );

  it("rejects archive symlinks even when the referenced bytes match", async () => {
    const f = fixture();
    const evidence = await executeRalphTask(
      { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
      f.cli,
    );
    const receipt = JSON.parse(readFileSync(evidence.receiptFile, "utf8"));
    const activeState = join(
      realpathSync(join(f.dir, "artifacts", "architecture-execution")),
      "ralph-active-state",
    );
    const archived = join(evidence.archivePath, relative(activeState, receipt.result.resultPath));
    const outside = join(f.dir, "outside-result.json");
    writeFileSync(outside, readFileSync(archived));
    unlinkSync(archived);
    symlinkSync(outside, archived);
    expect(() => readRalphTaskEvidence(f.workOrder)).toThrow(/archive|evidence/i);
  });

  it("marks reserved execution started before running preflight", async () => {
    const f = fixture("preflight-start");
    const marker = join(f.dir, "started-marker");
    f.workOrder.preflight.commands = [`test -f '${marker.replaceAll("'", "'\\''")}'`];
    const onStarted = vi.fn(() => writeFileSync(marker, "started"));
    await executeRalphTask(
      { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal, onStarted },
      f.cli,
    );
    expect(onStarted).toHaveBeenCalledOnce();
    expect(existsSync(join(f.dir, "args.json"))).toBe(true);
  });

  it("fences preflight and the external CLI when lifecycle ownership cannot be claimed", async () => {
    const f = fixture();
    await expect(
      executeRalphTask(
        {
          workOrder: f.workOrder,
          timeoutMs: 5000,
          signal: new AbortController().signal,
          onStarted: () => {
            throw new Error("fixture start ownership rejected");
          },
        },
        f.cli,
      ),
    ).rejects.toThrow("fixture start ownership rejected");
    expect(existsSync(join(f.dir, "args.json"))).toBe(false);
    expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(true);
  });

  it("inherits the isolated WorkOrder environment in preflight and host checks without leaking tasks", () => {
    const first = fixture("environment");
    const second = fixture("environment");
    const botRoot = join(first.dir, "bot root with spaces");
    mkdirSync(join(botRoot, "scripts"), { recursive: true });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const keys = [
      "TCB_STATE_DIR",
      "LOOP_WORK_ORDER_ID",
      "LOOP_PROJECT_ID",
      "LOOP_PROJECT_NAME",
      "LOOP_PROJECT_AGENT",
      "LOOP_PROJECT_GOAL",
      "LOOP_PROJECT_PATH",
      "LOOP_BOT_ROOT",
      "LOOP_PROJECT_TARGET_SCORE",
      "LOOP_PROJECT_MAX_ROUNDS",
    ];
    const before = keys.map((key) => process.env[key]);
    writeFileSync(
      join(botRoot, "scripts", "check-env.cjs"),
      `const fs=require('node:fs'); fs.writeFileSync(process.argv[2], JSON.stringify({cwd:process.cwd(),ambient:process.env.TCB_ENV_TEST_AMBIENT,values:Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]]))}));`,
    );
    for (const [index, f] of [first, second].entries()) {
      f.workOrder.targetScore = 95 + index;
      f.workOrder.projectId = `environment-${index}`;
      f.workOrder.id = `environment-work-order-${index}`;
      f.workOrder.preflight.commands = [
        `node "$LOOP_BOT_ROOT/scripts/check-env.cjs" ${quote(join(f.dir, "preflight.json"))}`,
      ];
      f.workOrder.assessment.command = `node "$LOOP_BOT_ROOT/scripts/check-env.cjs" ${quote(join(f.dir, "hostcheck.json"))}`;
    }
    const runner = join(first.dir, "run-environment.mts");
    writeFileSync(
      runner,
      `import {executeRalphTask} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/core/loop/ralph-task.ts")).href)}; const ambientBefore = JSON.stringify(process.env); for (const f of ${JSON.stringify([first, second])}) { await executeRalphTask({workOrder:f.workOrder,timeoutMs:15000,signal:new AbortController().signal},f.cli); if (JSON.stringify(process.env) !== ambientBefore) throw new Error("WorkOrder leaked into ambient environment"); }`,
    );
    execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), runner], {
      cwd: botRoot,
      env: {
        ...process.env,
        TCB_ENV_TEST_AMBIENT: "inherited-fixture",
        LOOP_PROJECT_PATH: "foreign-path",
        LOOP_BOT_ROOT: "foreign-root",
        LOOP_PROJECT_TARGET_SCORE: "1",
      },
      timeout: 40000,
      stdio: "pipe",
    });
    for (const f of [first, second]) {
      for (const phase of ["preflight", "hostcheck"]) {
        const observed = JSON.parse(readFileSync(join(f.dir, `${phase}.json`), "utf8"));
        expect(observed).toEqual({
          cwd: realpathSync(f.repo),
          ambient: "inherited-fixture",
          values: {
            TCB_STATE_DIR: expect.any(String),
            LOOP_WORK_ORDER_ID: f.workOrder.id,
            LOOP_PROJECT_ID: f.workOrder.projectId,
            LOOP_PROJECT_NAME: f.workOrder.projectName,
            LOOP_PROJECT_AGENT: f.workOrder.agent,
            LOOP_PROJECT_GOAL: f.workOrder.goal,
            LOOP_PROJECT_PATH: realpathSync(f.repo),
            LOOP_BOT_ROOT: realpathSync(botRoot),
            LOOP_PROJECT_TARGET_SCORE: String(f.workOrder.targetScore),
            LOOP_PROJECT_MAX_ROUNDS: String(f.workOrder.maxRounds),
          },
        });
      }
    }
    expect(keys.map((key) => process.env[key])).toEqual(before);
  }, 45000);

  it("runs a concrete bounded task in the owned worktree, archives state, and validates a receipt", async () => {
    const f = fixture();
    const evidence = await executeRalphTask(
      { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
      f.cli,
    );
    const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8")) as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "run",
        "--workspace",
        "current",
        "--commit",
        "none",
        "--executor",
        "host",
        "--profile",
        "builtin:architecture",
        "--param",
        "focus=parser",
        "--check",
        "printf assessment",
      ]),
    );
    expect(readFileSync(args[1] ?? "", "utf8")).toContain("Reduce coupling in the parser.");
    expect(readFileSync(args[1] ?? "", "utf8")).toContain("Do not commit");
    expect(evidence).toMatchObject({
      invocationId: expect.any(String),
      taskInputSha256: expect.any(String),
      receiptFile: expect.any(String),
    });
    expect(existsSync(join(f.repo, ".ralph"))).toBe(false);
    expect(existsSync(evidence.archivePath)).toBe(true);
    expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(false);
    expect(readRalphTaskEvidence(f.workOrder)).toMatchObject(evidence);
    await expect(
      executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      ),
    ).rejects.toThrow("already");
  });

  it.each([
    "foreign",
    "wrong-source",
    "wrong-head",
    "wrong-path",
    "ignored-state-dir",
    "state-symlink",
    "missing-output",
    "bad-output",
    "bad-check",
    "cancelled-check",
    "no-receipt",
    "bad-artifact",
    "failed",
  ])("blocks %s evidence without accepting or retrying", async (scenario) => {
    const f = fixture(scenario);
    await expect(
      executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      ),
    ).rejects.toThrow();
  });

  it("rejects preexisting Ralph state and dirty worktrees before invocation", async () => {
    const f = fixture();
    writeFileSync(join(f.repo, "user.txt"), "unrelated work");
    await expect(
      executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      ),
    ).rejects.toThrow("clean");
    expect(existsSync(join(f.dir, "args.json"))).toBe(false);
  });

  it("stops the observed child before returning on cancellation", async () => {
    const f = fixture("hang");
    const controller = new AbortController();
    const execution = executeRalphTask(
      { workOrder: f.workOrder, timeoutMs: 5000, signal: controller.signal },
      f.cli,
    );
    let executionSettled = false;
    let executionError: unknown;
    void execution.then(
      () => {
        executionSettled = true;
      },
      (error: unknown) => {
        executionSettled = true;
        executionError = error;
      },
    );
    const ready = join(f.dir, "hang-ready.pid");
    let pid: number | undefined;
    try {
      let observed = false;
      // The existing execution deadline bounds startup; do not race it with a shorter fixture cutoff.
      while (!executionSettled) {
        if (existsSync(ready)) pid = Number(readFileSync(ready, "utf8"));
        observed =
          pid !== undefined &&
          listLoopExecutionQuarantines().some(
            (record) =>
              record.workOrderId === f.workOrder.id &&
              record.processes.some((entry) => entry.pid === pid),
          );
        if (observed) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!observed)
        throw (
          executionError ?? new Error("Execution ended before fixture child ownership was ready")
        );
      controller.abort("test cancelled");
      await expect(execution).rejects.toThrow(/cancel|abort/i);
      if (pid === undefined) throw new Error("fixture child PID missing");
      const stoppedPid = pid;
      expect(() => process.kill(stoppedPid, 0)).toThrow();
    } finally {
      controller.abort("fixture cleanup");
      await execution.catch(() => {});
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  });
});

describe("external architecture acceptance", () => {
  it.each(["architecture", "bug-fix", "test-coverage", "security-maintenance"] as const)(
    "blocks a completed %s supervisor summary with missing CLI evidence before command gates",
    (kind) => {
      const f = fixture("completed", kind);
      let commands = 0;
      const gate = runSupervisedSystemGateOutcome({
        project: {
          id: f.workOrder.projectId,
          name: f.workOrder.projectName,
          path: f.repo,
          commit: f.workOrder.commitPolicy,
          pullRequest: {
            enabled: false,
            base: "main",
            switchBack: "main",
            autoMerge: false,
            mergeMethod: "squash",
          },
        },
        workOrder: f.workOrder,
        result: {
          status: "completed",
          summary: {
            status: "completed",
            projectId: f.workOrder.projectId,
            actionsTaken: [],
            delegatedTasks: [],
            finalVerification: "passed",
            commits: [],
            followUps: [],
          },
          output: "reported complete",
        },
        runCommand: () => {
          commands++;
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      expect(gate.failures.join(" ")).toContain("RalphWorks");
      expect(gate.result.status).toBe("supervisor-failed");
      expect(commands).toBe(0);
    },
  );

  it("rejects durable receipt and output tampering after native review", async () => {
    const f = fixture();
    const evidence = await executeRalphTask(
      { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
      f.cli,
    );
    writeFileSync(join(f.repo, "ARCHITECTURE_REPORT.md"), "changed after receipt");
    expect(() => readRalphTaskEvidence(f.workOrder)).toThrow("output changed");
    expect(() => readRalphTaskEvidence({ ...f.workOrder, goal: "different goal" })).toThrow(
      "identity",
    );
    writeFileSync(evidence.receiptFile, "{}");
    expect(() => readRalphTaskEvidence(f.workOrder)).toThrow();
  });
});

describe("receipt lifecycle quarantine", () => {
  it("retains ownership for a fast detached helper that exits without a receipt", async () => {
    const f = fixture("fast-detach");
    try {
      await expect(
        executeRalphTask(
          { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
          f.cli,
        ),
      ).rejects.toThrow();
      expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(true);
      await expect(
        executeRalphTask(
          {
            workOrder: { ...f.workOrder, id: "next-run" },
            timeoutMs: 5000,
            signal: new AbortController().signal,
          },
          f.cli,
        ),
      ).rejects.toThrow();
    } finally {
      const pid = Number(readFileSync(join(f.dir, "detached.pid"), "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
  it("releases quarantine for an identity-valid declared failure after all recorded children stop", async () => {
    const f = fixture("failed");
    await expect(
      executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      ),
    ).rejects.toThrow("declared failed");
    expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(false);
  });
  it("preserves max_iterations as failure without native review or delivery despite passing checks", async () => {
    const f = fixture("max-iterations");
    const dispatch = vi.fn(async () => {
      throw new Error("must not finalize");
    });
    const result = await runLoopSupervisedProjectAsync({
      workOrder: f.workOrder,
      supervisorSession: "supervisor",
      timeoutMs: 10000,
      executeTask: (input) => executeRalphTask(input, f.cli),
      dispatch,
    });
    expect(result.status).toBe("dispatch-failed");
    expect(dispatch).not.toHaveBeenCalled();
    const attempt = join(f.dir, "artifacts", "architecture-execution");
    const receipt = JSON.parse(readFileSync(join(attempt, "receipt.json"), "utf8"));
    expect(receipt.result).toMatchObject({ status: "max_iterations", iterations: 2, commits: [] });
    expect(receipt.result.checks).toEqual([
      expect.objectContaining({ iteration: 1, exitCode: 0 }),
      expect.objectContaining({ iteration: 1, exitCode: 0 }),
      expect.objectContaining({ iteration: 2, exitCode: 0 }),
      expect.objectContaining({ iteration: 2, exitCode: 0 }),
    ]);
    expect(existsSync(join(f.repo, "ARCHITECTURE_REPORT.md"))).toBe(true);
    expect(existsSync(join(attempt, "declared-failure.json"))).toBe(true);
    expect(existsSync(join(attempt, "accepted-receipt.json"))).toBe(false);
    expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(false);
  });
});

describe("compatible cancellation receipts", () => {
  it.each([
    "receipt-cancel",
    "late-complete-cancel",
    "foreign-cancel",
    "no-cancel-receipt",
    "force-cancel",
  ])("maps %s to bot cancellation without native delivery", async (scenario) => {
    const f = fixture(scenario);
    const controller = new AbortController();
    let nativeDispatches = 0;
    const run = runLoopSupervisedProjectAsync({
      workOrder: f.workOrder,
      supervisorSession: "supervisor",
      timeoutMs: 10000,
      cancelSignal: controller.signal,
      executeTask: (input) => executeRalphTask(input, f.cli),
      dispatch: async () => {
        nativeDispatches++;
        throw new Error("must not finalize");
      },
    });
    const deadline = Date.now() + 6000;
    const ready = join(f.dir, "cancel-ready.pid");
    while (!existsSync(ready) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const pid = Number(readFileSync(ready, "utf8"));
    try {
      controller.abort("operator cancelled");
      const result = await run;
      expect(result).toMatchObject({ status: "cancelled", finalSummaryRecovery: "disabled" });
      expect(nativeDispatches).toBe(0);
      const compatible = scenario === "receipt-cancel" || scenario === "late-complete-cancel";
      expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(!compatible);
      if (compatible) {
        const record = JSON.parse(
          readFileSync(
            join(f.dir, "artifacts/architecture-execution/reconciled-stop.json"),
            "utf8",
          ),
        );
        expect(record.botOutcome).toBe("cancelled");
        expect(record.receiptStatus).toBe(
          scenario === "late-complete-cancel" ? "completed" : "cancelled",
        );
        expect(existsSync(join(f.repo, ".ralph"))).toBe(false);
      }
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
});

describe("optional maintenance CLI delegation", () => {
  it.each(["bug-fix", "test-coverage", "security-maintenance"] as const)(
    "executes %s and revalidates its own report",
    async (kind) => {
      const f = fixture("completed", kind);
      const evidence = await executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      );
      const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8")) as string[];
      const profile =
        kind === "bug-fix"
          ? "builtin:bugfix"
          : kind === "security-maintenance"
            ? "builtin:security-maintenance"
            : "builtin:test-coverage";
      const report =
        kind === "bug-fix"
          ? "BUGFIX_REPORT.md"
          : kind === "security-maintenance"
            ? "SECURITY_REPORT.md"
            : "COVERAGE_REPORT.md";
      expect(args[args.indexOf("--profile") + 1]).toBe(profile);
      expect(readFileSync(args[1] ?? "", "utf8")).toContain(report);
      expect(readRalphTaskEvidence(f.workOrder)).toMatchObject(evidence);
      writeFileSync(join(f.repo, report), "tampered after review");
      expect(() => readRalphTaskEvidence(f.workOrder)).toThrow("output changed");
    },
  );
  it.each(["bug-fix", "test-coverage", "security-maintenance"] as const)(
    "rejects an architecture report for %s",
    async (kind) => {
      const f = fixture("wrong-report", kind);
      await expect(
        executeRalphTask(
          { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
          f.cli,
        ),
      ).rejects.toThrow("report is missing");
    },
  );
});

describe("security receipt rejection", () => {
  it.each([
    "foreign",
    "wrong-source",
    "wrong-head",
    "wrong-path",
    "bad-check",
    "cancelled-check",
    "no-receipt",
    "bad-artifact",
    "failed",
  ])("blocks %s without accepting or retrying security implementation", async (scenario) => {
    const f = fixture(scenario, "security-maintenance");
    await expect(
      executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      ),
    ).rejects.toThrow();
    expect(
      existsSync(join(f.dir, "artifacts", "external-execution", "accepted-receipt.json")),
    ).toBe(false);
  });
});

describe("caller maintenance policy", () => {
  it.each(
    (["architecture", "bug-fix", "test-coverage", "security-maintenance"] as const).flatMap(
      (kind) => [false, true].map((planning) => ({ kind, planning })),
    ),
  )(
    "scopes $kind completion to external work with planning=$planning",
    async ({ kind, planning }) => {
      const f = fixture("completed", kind);
      const goal =
        'Repair the parser, complete native review, create a verified commit and publish a PR.\nPreserve the "strict" compatibility contract.';
      f.workOrder.goal = goal;
      f.workOrder.maxRounds = 2;
      const policy = f.workOrder.task;
      if (
        policy?.kind === "bug-fix" ||
        policy?.kind === "test-coverage" ||
        policy?.kind === "security-maintenance"
      ) {
        policy.prompt = `Keep local verification mandatory.\n${goal}`;
        policy.maxRounds = 2;
      }
      if (planning) {
        f.workOrder.planning = {
          required: true,
          source: "task-family",
          requireOwnerConfirmation: false,
          rubric: ["Preserve baseline evidence before editing."],
          acceptanceCriteria: [
            "Pass the required local parser checks without weakening thresholds.",
            "Complete native review, commit and publish the PR.",
          ],
          stopConditions: ["Stop if the compatibility contract cannot be verified."],
          nonGoals: ["No unrelated parser redesign."],
        };
      } else {
        delete f.workOrder.planning;
      }
      await executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      );
      const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8")) as string[];
      const task = readFileSync(args[1] ?? "", "utf8");
      expect(task).toContain(goal);
      expect(task).toMatch(/overall WorkOrder goal.*context/i);
      expect(task).toMatch(/External implementation phase:/);
      expect(task).toMatch(/bounded implementation, required local verification/);
      expect(task).toMatch(
        /Native review, final system acceptance, commits and PR delivery belong to the bot/,
      );
      expect(task).toMatch(/downstream actions alone must not prevent.*completion/);
      expect(task).toMatch(/Missing.*local verification.*blocks.*completion/);
      expect(task).toMatch(/skipped assessment.*measured success/);
      expect(task).toMatch(/scheduled checks.*output validation.*after.*return/i);
      if (
        policy?.kind === "bug-fix" ||
        policy?.kind === "test-coverage" ||
        policy?.kind === "security-maintenance"
      ) {
        const serializedPolicy = task.match(/\n({\n[\s\S]*?\n})\n/)?.[1];
        expect(serializedPolicy).toBeDefined();
        expect(JSON.parse(serializedPolicy ?? "{}").prompt).toBe(policy.prompt);
        expect(task).toMatch(/task-specific prompt.*phase boundary/);
      }
      if (planning) {
        for (const item of [
          ...(f.workOrder.planning?.acceptanceCriteria ?? []),
          ...(f.workOrder.planning?.stopConditions ?? []),
          ...(f.workOrder.planning?.nonGoals ?? []),
        ])
          expect(task).toContain(item);
      }
      expect(task).toMatch(/Caller acceptance criteria.*external phase boundary/);
      expect(args[args.indexOf("--commit") + 1]).toBe("none");
      expect(args[args.indexOf("--max-iterations") + 1]).toBe("2");
      expect(args.filter((_, index) => args[index - 1] === "--check")).toEqual([
        "printf assessment",
      ]);
      const report =
        kind === "architecture"
          ? "ARCHITECTURE_REPORT.md"
          : kind === "bug-fix"
            ? "BUGFIX_REPORT.md"
            : kind === "test-coverage"
              ? "COVERAGE_REPORT.md"
              : "SECURITY_REPORT.md";
      expect(task).toContain(report);
    },
  );

  it.each(["bug-fix", "test-coverage", "security-maintenance"] as const)(
    "passes %s built-in parameters and full task constraints",
    async (kind) => {
      const f = fixture("completed", kind);
      if (f.workOrder.task?.kind === "security-maintenance") {
        Object.assign(f.workOrder.task, {
          actionThreshold: 71,
          criticalThreshold: 92,
          maxRounds: 4,
          allowDependencyUpdates: false,
          allowConfigHardening: false,
          allowStaticAnalysisFixes: true,
          cleanupPolicy: "balanced",
          prompt: "Focus on reachable webhook risks.",
        });
      }
      if (f.workOrder.task?.kind === "bug-fix") {
        f.workOrder.task.maxBugsPerRound = 3;
        f.workOrder.task.requireRegressionTest = true;
        f.workOrder.task.prompt = "Focus on cancellation races.";
      }
      if (f.workOrder.task?.kind === "test-coverage") {
        f.workOrder.task.targetCoverage = 93;
        f.workOrder.task.allowIntegrationTests = false;
        f.workOrder.task.allowE2ETests = true;
        f.workOrder.task.allowSmokeTests = false;
        f.workOrder.task.allowAiEvalTests = false;
        f.workOrder.task.prompt = "Focus on parser error handling.";
      }
      await executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      );
      const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8")) as string[];
      expect(args).toEqual(
        expect.arrayContaining(
          kind === "bug-fix"
            ? ["mode=discover", "maxFixes=3"]
            : kind === "security-maintenance"
              ? [
                  "allowDependencyUpdates=false",
                  "allowConfigHardening=false",
                  "allowStaticAnalysisFixes=true",
                ]
              : ["targetCoverage=93", "includeIntegration=false", "includeE2E=true"],
        ),
      );
      const task = readFileSync(args[1] ?? "", "utf8");
      expect(task).toContain("Focus on");
      if (kind === "security-maintenance") {
        for (const constraint of [
          '"criticalThreshold": 92',
          '"maxRounds": 4',
          '"cleanupPolicy": "balanced"',
        ])
          expect(task).toContain(constraint);
        expect(args.some((arg) => arg.startsWith("maxFixes="))).toBe(false);
      }
      expect(task).toContain(
        kind === "bug-fix"
          ? '"requireRegressionTest": true'
          : kind === "security-maintenance"
            ? '"actionThreshold": 71'
            : '"allowSmokeTests": false',
      );
    },
  );
  it.each(["bug-fix", "test-coverage", "security-maintenance"] as const)(
    "rejects conflicting %s built-in params before launch or reservation",
    async (kind) => {
      const f = fixture("completed", kind);
      if (
        f.workOrder.task?.kind !== "bug-fix" &&
        f.workOrder.task?.kind !== "test-coverage" &&
        f.workOrder.task?.kind !== "security-maintenance"
      )
        throw new Error("missing task");
      f.workOrder.task.implementation = {
        kind: "ralphworks",
        params:
          kind === "bug-fix"
            ? { mode: "reported" }
            : kind === "security-maintenance"
              ? { allowStaticAnalysisFixes: false }
              : { targetCoverage: 1 },
      };
      await expect(
        executeRalphTask(
          { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
          f.cli,
        ),
      ).rejects.toThrow("conflicts");
      expect(existsSync(join(f.dir, "args.json"))).toBe(false);
      expect(existsSync(join(f.dir, "artifacts"))).toBe(false);
      expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(false);
    },
  );
  it.each(["bug-fix", "test-coverage", "security-maintenance"] as const)(
    "keeps a custom %s profile's parameter contract opaque",
    async (kind) => {
      const f = fixture("completed", kind);
      if (
        f.workOrder.task?.kind !== "bug-fix" &&
        f.workOrder.task?.kind !== "test-coverage" &&
        f.workOrder.task?.kind !== "security-maintenance"
      )
        throw new Error("missing task");
      f.workOrder.task.implementation = {
        kind: "ralphworks",
        profile: "project:custom",
        params: { focus: "parser" },
      };
      await executeRalphTask(
        { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
        f.cli,
      );
      const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8")) as string[];
      expect(args.filter((_, i) => args[i - 1] === "--param")).toEqual(["focus=parser"]);
      expect(readRalphTaskEvidence(f.workOrder)).toBeDefined();
    },
  );
  it.each(["bug-fix", "test-coverage", "security-maintenance"] as const)(
    "blocks %s failed verification without fallback",
    async (kind) => {
      const f = fixture("bad-check", kind);
      await expect(
        executeRalphTask(
          { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
          f.cli,
        ),
      ).rejects.toThrow("verification checks failed");
      expect(hasLoopExecutionQuarantine(f.workOrder.id)).toBe(true);
    },
  );
});

describe("external task ownership constraints", () => {
  it.each(["bug-fix", "test-coverage", "security-maintenance"] as const)(
    "rejects forged workspace delegation for %s before side effects",
    async (kind) => {
      const f = fixture("completed", kind);
      f.workOrder.workspace = { root: f.repo, repositories: [] };
      await expect(
        executeRalphTask(
          { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
          f.cli,
        ),
      ).rejects.toThrow("single-repository");
      expect(existsSync(join(f.dir, "args.json"))).toBe(false);
      expect(existsSync(join(f.dir, "artifacts"))).toBe(false);
    },
  );
  it("caps the built-in bugfix budget within its supported range and caller limit", async () => {
    const f = fixture("completed", "bug-fix");
    if (f.workOrder.task?.kind !== "bug-fix") throw new Error("missing task");
    f.workOrder.task.maxBugsPerRound = 20;
    await executeRalphTask(
      { workOrder: f.workOrder, timeoutMs: 5000, signal: new AbortController().signal },
      f.cli,
    );
    const args = JSON.parse(readFileSync(join(f.dir, "args.json"), "utf8")) as string[];
    expect(args).toContain("maxFixes=10");
  });
});
