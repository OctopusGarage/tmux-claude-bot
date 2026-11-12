import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  assertRalphPrReviewPasses,
  parseRalphCodeReview,
  ralphPrReviewDeadline,
  readPrReviewWorkOrder,
  reserveRalphPrReviewDeadline,
  runRalphPrReviewPass,
  validateRalphPrReviewGate,
} from "../../src/core/loop/ralph-pr-review.js";
import { buildRepositoryPullRequestReviewWorkOrder } from "../../src/core/loop/work-order.js";

const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40), diffSha256: "c".repeat(64) };
const clean = {
  schemaVersion: 1,
  revision,
  verdict: "clean",
  reviewedScope: "Changed parser behavior",
  findings: [],
  limitations: [],
};

describe("revision-bound external PR review", () => {
  it("validates a clean review for the exact immutable revision", () => {
    expect(parseRalphCodeReview(clean, revision).verdict).toBe("clean");
  });
  it("rejects old heads, mismatched diffs and contradictory clean findings", () => {
    expect(() => parseRalphCodeReview(clean, { ...revision, headSha: "d".repeat(40) })).toThrow();
    expect(() =>
      parseRalphCodeReview(clean, { ...revision, diffSha256: "d".repeat(64) }),
    ).toThrow();
    expect(() => parseRalphCodeReview({ ...clean, verdict: "findings" }, revision)).toThrow();
  });
  it("does not turn incomplete review into approval", () => {
    expect(
      parseRalphCodeReview(
        { ...clean, verdict: "incomplete", limitations: ["Missing caller context"] },
        revision,
      ).verdict,
    ).toBe("incomplete");
  });
});

function fixture(scenario = "clean") {
  const dir = mkdtempSync(join(tmpdir(), "tcb-pr-review-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", repo]);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");
  git(["add", ".gitignore"]);
  if (scenario === "preexisting-state") {
    mkdirSync(join(repo, ".ralph"));
    writeFileSync(join(repo, ".ralph", "prior.json"), "{}");
    git(["add", ".ralph"]);
  }
  if (scenario === "preexisting-output") {
    writeFileSync(join(dir, "victim.txt"), "preserve outside file");
    symlinkSync(join(dir, "victim.txt"), join(repo, "CODE_REVIEW.json"));
    git(["add", "CODE_REVIEW.json"]);
  }
  if (scenario === "collision") {
    writeFileSync(join(repo, "a.txt"), "x");
    writeFileSync(join(repo, "b.txt"), `${JSON.stringify(["b.txt", 33188])}y`);
    git(["add", "a.txt", "b.txt"]);
  }
  writeFileSync(join(repo, "source.txt"), "original\n");
  git(["add", "source.txt"]);
  git(["commit", "-m", "base"]);
  const baseSha = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "source.txt"), "changed\n");
  git(["commit", "-am", "candidate"]);
  const headSha = git(["rev-parse", "HEAD"]);
  const config = parseLoopConfigYaml(
    `projects: []\nprReview:\n  repositories:\n    - id: example\n      name: Example\n      path: ${repo}\n      repo: fixture/repo\n      agent: codex\n      schedule: '0 0 * * *'\n      githubAccount: fixture\n      reviewer: {kind: ralphworks}\n`,
  );
  const repository = config.prReview.repositories[0];
  if (!repository) throw new Error("missing repo");
  const workOrder = buildRepositoryPullRequestReviewWorkOrder({
    config,
    repository,
    runId: "review-1",
    scheduledAt: Date.now(),
  });
  mkdirSync(join(dir, "artifacts"));
  workOrder.finalSummaryPath = join(dir, "artifacts", "supervisor-final-summary.json");
  reserveRalphPrReviewDeadline(workOrder, 60000);
  writeFileSync(join(dir, "artifacts", "work-order.json"), JSON.stringify(workOrder));
  const cli = join(dir, "fake-ralph");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const args=process.argv.slice(2),arg=n=>args[args.indexOf(n)+1],hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const order=JSON.parse(fs.readFileSync(path.join(path.dirname(args[1]),'../work-order.json'),'utf8'));
const context=order.task.reviewContext,scenario=${JSON.stringify(scenario)};
const verdict=scenario==='findings'?'findings':scenario==='incomplete'?'incomplete':'clean';
const report={schemaVersion:1,revision:{baseSha:context.baseSha,headSha:context.headSha,diffSha256:context.diffSha256},verdict,reviewedScope:'Changed source behavior',findings:verdict==='findings'?[{severity:'P1',path:'source.txt',line:1,title:'Introduced regression',trigger:'Changed input',consequence:'Wrong result',remedy:'Restore correct result',evidence:['source.txt:1']}]:[],limitations:verdict==='incomplete'?['Required context unavailable']:[]};
fs.writeFileSync('CODE_REVIEW.json',JSON.stringify(report));
if(scenario==='collision'){fs.writeFileSync('a.txt','x'+JSON.stringify(['b.txt',fs.statSync('b.txt').mode]));fs.writeFileSync('b.txt','y');}
if(scenario==='mutate')fs.writeFileSync('source.txt','unauthorized source mutation');
if(scenario==='ignored-write'){fs.mkdirSync('ignored',{recursive:true});fs.writeFileSync('ignored/bad.txt','unauthorized');}
const runDir=path.join(arg('--state-dir'),'runs/review');fs.mkdirSync(runDir,{recursive:true});
fs.writeFileSync(path.join(arg('--state-dir'),'invocation.json'),JSON.stringify({args,workspace:process.cwd()}));
const checks=[];for(let i=0;i<args.length;i++)if(args[i]==='--check')checks.push({iteration:1,command:args[i+1],exitCode:0,stdout:'',stderr:''});
checks.push({iteration:1,command:'output: CODE_REVIEW.json',exitCode:0,stdout:'',stderr:''});
const result={jobName:'review',status:'completed',iterations:1,runDir,eventsPath:path.join(runDir,'events.jsonl'),resultPath:path.join(runDir,'result.json'),checks,costUsd:0,commits:[]};
fs.writeFileSync(result.eventsPath,'{}\\n');fs.writeFileSync(result.resultPath,JSON.stringify(result));
const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const receipt={schemaVersion:1,invocationId:arg('--invocation-id'),startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),workspace:{path:process.cwd(),baseHead:head,head},taskInputSha256:hash(fs.readFileSync(args[1])),profile:{name:'code-review',fingerprint:hash('profile')},result,outputs:[{path:'CODE_REVIEW.json',required:true,format:'json',sha256:hash(fs.readFileSync('CODE_REVIEW.json'))}]};
fs.writeFileSync(arg('--result-file'),JSON.stringify(receipt));
`,
  );
  chmodSync(cli, 0o755);
  return { dir, repo, workOrder, baseSha, headSha, cli };
}

describe("external PR pass CLI transport and acceptance", () => {
  it("records proven shutdown when task prechecks fail before external reservation", async () => {
    const f = fixture("preexisting-state");
    await expect(
      runRalphPrReviewPass(
        {
          workOrder: f.workOrder,
          number: 1,
          repository: "fixture/repo",
          baseSha: f.baseSha,
          headSha: f.headSha,
          timeoutMs: 30000,
          signal: new AbortController().signal,
        },
        f.cli,
      ),
    ).rejects.toThrow("state already exists");
    const root = join(f.dir, "artifacts", "pr-reviews", "1");
    const pass = readdirSync(root)[0];
    if (!pass) throw new Error("Missing failed pass");
    const passDir = join(root, pass);
    expect(existsSync(join(passDir, "external-execution"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(passDir, "preparation-finished.json"), "utf8")),
    ).toMatchObject({ knownProcessesStopped: true });
  });

  it("persists snapshot ownership before a preparation failure", async () => {
    const f = fixture("preexisting-output");
    await expect(
      runRalphPrReviewPass(
        {
          workOrder: f.workOrder,
          number: 1,
          repository: "fixture/repo",
          baseSha: f.baseSha,
          headSha: f.headSha,
          timeoutMs: 30000,
          signal: new AbortController().signal,
        },
        f.cli,
      ),
    ).rejects.toThrow("Reserved CODE_REVIEW.json");
    const root = join(f.dir, "artifacts", "pr-reviews", "1");
    const pass = readdirSync(root)[0];
    if (!pass) throw new Error("Missing failed pass");
    const passDir = join(root, pass);
    const snapshot = JSON.parse(readFileSync(join(passDir, "work-order.json"), "utf8"));
    expect(snapshot.projectPath).toBe(join(passDir, "worktree"));
    expect(
      JSON.parse(readFileSync(join(passDir, "preparation-finished.json"), "utf8")),
    ).toMatchObject({ workOrderId: snapshot.id, knownProcessesStopped: true });
    expect(existsSync(join(root, "active"))).toBe(false);
  });

  it("rejects another review pass after its parent has settled", async () => {
    const f = fixture();
    writeFileSync(
      join(f.dir, "artifacts", "work-order-state.json"),
      JSON.stringify({ status: "completed" }),
    );
    await expect(
      runRalphPrReviewPass(
        {
          workOrder: f.workOrder,
          number: 1,
          repository: "fixture/repo",
          baseSha: f.baseSha,
          headSha: f.headSha,
          timeoutMs: 30000,
          signal: new AbortController().signal,
        },
        f.cli,
      ),
    ).rejects.toThrow("terminal");
    expect(readdirSync(join(f.dir, "artifacts", "pr-reviews", "1"))).toEqual([]);
  });

  it("requires two independently invoked clean passes at the current revision", async () => {
    const f = fixture();
    const input = {
      workOrder: f.workOrder,
      number: 1,
      repository: "fixture/repo",
      baseSha: f.baseSha,
      headSha: f.headSha,
      timeoutMs: 30000,
      signal: new AbortController().signal,
    };
    const first = await runRalphPrReviewPass(input, f.cli);
    const firstAccepted = JSON.parse(readFileSync(first.evidencePath, "utf8"));
    const invocation = JSON.parse(
      readFileSync(join(firstAccepted.evidence.archivePath, "invocation.json"), "utf8"),
    );
    expect(invocation.args[invocation.args.indexOf("--state-dir") + 1]).toBe(
      join(realpathSync(dirname(firstAccepted.evidence.receiptFile)), "ralph-active-state"),
    );
    expect(invocation.workspace).toBe(realpathSync(firstAccepted.snapshotOrder.projectPath));
    expect(existsSync(join(firstAccepted.snapshotOrder.projectPath, ".ralph"))).toBe(false);

    const decision = {
      number: 1,
      repository: "fixture/repo",
      outcome: "approved" as const,
      reviewedHeadSha: f.headSha,
      evidence: [first.evidencePath],
      nextStep: "Check CI",
    };
    expect(() =>
      assertRalphPrReviewPasses(f.workOrder, decision, { baseSha: f.baseSha, headSha: f.headSha }),
    ).toThrow("consecutive");
    const second = await runRalphPrReviewPass(input, f.cli);
    expect(second.pass).toBe(2);
    expect(() =>
      assertRalphPrReviewPasses(f.workOrder, decision, { baseSha: f.baseSha, headSha: f.headSha }),
    ).not.toThrow();
    expect(() =>
      assertRalphPrReviewPasses(f.workOrder, decision, {
        baseSha: f.baseSha,
        headSha: "a".repeat(40),
      }),
    ).toThrow("advanced");
    const accepted = JSON.parse(readFileSync(second.evidencePath, "utf8"));
    writeFileSync(join(accepted.snapshotOrder.projectPath, "CODE_REVIEW.json"), "{}");
    expect(() =>
      assertRalphPrReviewPasses(f.workOrder, decision, { baseSha: f.baseSha, headSha: f.headSha }),
    ).toThrow();
    expect(readFileSync(join(f.repo, "source.txt"), "utf8")).toBe("changed\n");
  });
  it.each(["findings", "incomplete"])("never accepts %s as a clean PR review", async (scenario) => {
    const f = fixture(scenario);
    const result = await runRalphPrReviewPass(
      {
        workOrder: f.workOrder,
        number: 1,
        repository: "fixture/repo",
        baseSha: f.baseSha,
        headSha: f.headSha,
        timeoutMs: 30000,
        signal: new AbortController().signal,
      },
      f.cli,
    );
    expect(result.verdict).toBe(scenario);
    expect(() =>
      assertRalphPrReviewPasses(
        f.workOrder,
        {
          number: 1,
          repository: "fixture/repo",
          outcome: "approved",
          reviewedHeadSha: f.headSha,
          evidence: [result.evidencePath],
          nextStep: "Check CI",
        },
        { baseSha: f.baseSha, headSha: f.headSha },
      ),
    ).toThrow("consecutive");
  });
  it.each(["mutate", "ignored-write", "collision"])(
    "rejects %s in the disposable candidate snapshot",
    async (scenario) => {
      const f = fixture(scenario);
      await expect(
        runRalphPrReviewPass(
          {
            workOrder: f.workOrder,
            number: 1,
            repository: "fixture/repo",
            baseSha: f.baseSha,
            headSha: f.headSha,
            timeoutMs: 30000,
            signal: new AbortController().signal,
          },
          f.cli,
        ),
      ).rejects.toThrow("modified source");
      expect(readFileSync(join(f.repo, "source.txt"), "utf8")).toBe("changed\n");
    },
  );
});

describe("PR review failure evidence", () => {
  it("resets consecutive clean passes after a failed CLI attempt", async () => {
    const f = fixture();
    const input = {
      workOrder: f.workOrder,
      number: 1,
      repository: "fixture/repo",
      baseSha: f.baseSha,
      headSha: f.headSha,
      timeoutMs: 30000,
      signal: new AbortController().signal,
    };
    const first = await runRalphPrReviewPass(input, f.cli);
    const script = readFileSync(f.cli, "utf8");
    writeFileSync(f.cli, `#!${process.execPath}\nprocess.exit(1);\n`);
    await expect(runRalphPrReviewPass(input, f.cli)).rejects.toThrow();
    writeFileSync(f.cli, script);
    const third = await runRalphPrReviewPass(input, f.cli);
    expect(third.pass).toBe(3);
    const decision = {
      number: 1,
      repository: "fixture/repo",
      outcome: "approved" as const,
      reviewedHeadSha: f.headSha,
      evidence: [first.evidencePath, third.evidencePath],
      nextStep: "Check CI",
    };
    expect(() =>
      assertRalphPrReviewPasses(f.workOrder, decision, { baseSha: f.baseSha, headSha: f.headSha }),
    ).toThrow("consecutive");
    await runRalphPrReviewPass(input, f.cli);
    expect(() =>
      assertRalphPrReviewPasses(f.workOrder, decision, { baseSha: f.baseSha, headSha: f.headSha }),
    ).not.toThrow();
  });
  it("rejects duplicated invocation evidence counted as independent passes", async () => {
    const f = fixture();
    const first = await runRalphPrReviewPass(
      {
        workOrder: f.workOrder,
        number: 1,
        repository: "fixture/repo",
        baseSha: f.baseSha,
        headSha: f.headSha,
        timeoutMs: 30000,
        signal: new AbortController().signal,
      },
      f.cli,
    );
    const accepted = JSON.parse(readFileSync(first.evidencePath, "utf8"));
    const duplicate = join(f.dir, "artifacts/pr-reviews/1/duplicate");
    mkdirSync(duplicate);
    writeFileSync(
      join(duplicate, "attempt.json"),
      JSON.stringify({
        workOrderSha256: accepted.workOrderSha256,
        sequence: 2,
        number: 1,
        repository: "fixture/repo",
      }),
    );
    writeFileSync(
      join(duplicate, "accepted-review.json"),
      JSON.stringify({ ...accepted, sequence: 2 }),
    );
    expect(() =>
      assertRalphPrReviewPasses(
        f.workOrder,
        {
          number: 1,
          repository: "fixture/repo",
          outcome: "approved",
          reviewedHeadSha: f.headSha,
          evidence: [first.evidencePath],
          nextStep: "Check CI",
        },
        { baseSha: f.baseSha, headSha: f.headSha },
      ),
    ).toThrow();
  });
});

describe("external PR acceptance scope and deadline", () => {
  it("accepts an independently discovered empty project scope", () => {
    const f = fixture();
    f.workOrder.id = "project-review";
    f.workOrder.finalSummaryPath = join(
      f.dir,
      "project-artifacts",
      "supervisor-final-summary.json",
    );
    f.workOrder.task = {
      kind: "pull-request-review",
      reviewer: { kind: "ralphworks" },
      lookbackHours: 72,
      consecutivePasses: 2,
      autoMerge: false,
      mergeMethod: "squash",
    };
    reserveRalphPrReviewDeadline(f.workOrder, 30000);
    const commands: string[] = [];
    expect(() =>
      validateRalphPrReviewGate(f.workOrder, [], (invocation) => {
        commands.push(invocation.command);
        expect(invocation.timeoutMs).toBeGreaterThan(0);
        return {
          status: 0,
          stderr: "",
          stdout: invocation.command.includes("repo view")
            ? JSON.stringify({ nameWithOwner: "fixture/repo" })
            : "[]",
        };
      }),
    ).not.toThrow();
    expect(commands).toHaveLength(2);
  });
  it("cannot omit an open in-scope candidate or extend its original deadline", () => {
    const f = fixture();
    const deadline = ralphPrReviewDeadline(f.workOrder);
    reserveRalphPrReviewDeadline(f.workOrder, 600000);
    expect(ralphPrReviewDeadline(f.workOrder)).toBe(deadline);
    expect(() =>
      validateRalphPrReviewGate(f.workOrder, [], () => ({
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          { number: 1, headRefName: "feature", title: "Candidate", body: "", baseRefName: "main" },
        ]),
      })),
    ).toThrow("omitted");
    const path = join(f.dir, "artifacts", "pr-review-deadline.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...value, expiresAt: Date.now() - 1 }));
    expect(() =>
      validateRalphPrReviewGate(f.workOrder, [], () => {
        throw new Error("must not execute after deadline");
      }),
    ).toThrow("deadline");
  });
  it("binds the public pass command to the canonical original WorkOrder", () => {
    const f = fixture();
    expect(readPrReviewWorkOrder(join(f.dir, "artifacts", "work-order.json")).id).toBe(
      f.workOrder.id,
    );
    const other = join(f.dir, "copied-order.json");
    writeFileSync(other, JSON.stringify(f.workOrder));
    expect(() => readPrReviewWorkOrder(other)).toThrow("location");
  });
  it("canonical diff ignores external diff configuration", async () => {
    const f = fixture();
    execFileSync("git", ["-C", f.repo, "config", "diff.external", "/usr/bin/true"]);
    const result = await runRalphPrReviewPass(
      {
        workOrder: f.workOrder,
        number: 1,
        repository: "fixture/repo",
        baseSha: f.baseSha,
        headSha: f.headSha,
        timeoutMs: 30000,
        signal: new AbortController().signal,
      },
      f.cli,
    );
    const accepted = JSON.parse(readFileSync(result.evidencePath, "utf8"));
    expect(accepted.snapshotOrder.task.reviewContext.diff).toContain("+changed");
    writeFileSync(join(accepted.snapshotOrder.projectPath, "source.txt"), "post-review mutation");
    expect(() =>
      assertRalphPrReviewPasses(
        f.workOrder,
        {
          number: 1,
          repository: "fixture/repo",
          outcome: "approved",
          reviewedHeadSha: f.headSha,
          evidence: [result.evidencePath],
          nextStep: "Check CI",
        },
        { baseSha: f.baseSha, headSha: f.headSha },
      ),
    ).toThrow("source changed");
  });
  it("matches public Unicode lengths and rejects control characters in finding paths", () => {
    expect(
      parseRalphCodeReview({ ...clean, reviewedScope: "😀".repeat(10000) }, revision).verdict,
    ).toBe("clean");
    expect(parseRalphCodeReview({ ...clean, verdict: "incomplete" }, revision).verdict).toBe(
      "incomplete",
    );
    expect(() =>
      parseRalphCodeReview(
        {
          ...clean,
          verdict: "findings",
          findings: [
            {
              severity: "P1",
              path: "source\u0000.txt",
              line: 1,
              title: "Defect",
              trigger: "Input",
              consequence: "Wrong output",
              remedy: "Correct output",
              evidence: ["Source"],
            },
          ],
        },
        revision,
      ),
    ).toThrow();
  });
});

it("does not combine reviews of distinct frozen bases after a merge", async () => {
  const f = fixture();
  const input = {
    workOrder: f.workOrder,
    number: 1,
    repository: "fixture/repo",
    baseSha: f.baseSha,
    headSha: f.headSha,
    timeoutMs: 30000,
    signal: new AbortController().signal,
  };
  const first = await runRalphPrReviewPass(input, f.cli);
  const tree = execFileSync("git", ["-C", f.repo, "rev-parse", `${f.baseSha}^{tree}`], {
    encoding: "utf8",
  }).trim();
  const alternate = execFileSync(
    "git",
    ["-C", f.repo, "commit-tree", tree, "-p", f.baseSha, "-m", "Alternate identical-tree base"],
    { encoding: "utf8" },
  ).trim();
  execFileSync("git", ["-C", f.repo, "branch", "alternate-base", alternate]);
  await runRalphPrReviewPass({ ...input, baseSha: alternate }, f.cli);
  expect(() =>
    assertRalphPrReviewPasses(
      f.workOrder,
      {
        number: 1,
        repository: "fixture/repo",
        outcome: "merged",
        reviewedHeadSha: f.headSha,
        evidence: [first.evidencePath],
        nextStep: "Verify merge",
      },
      { headSha: f.headSha },
    ),
  ).toThrow("consecutive");
});

it("rejects a preexisting report symlink before the reviewer can overwrite its target", async () => {
  const f = fixture("preexisting-output");
  await expect(
    runRalphPrReviewPass(
      {
        workOrder: f.workOrder,
        number: 1,
        repository: "fixture/repo",
        baseSha: f.baseSha,
        headSha: f.headSha,
        timeoutMs: 30000,
        signal: new AbortController().signal,
      },
      f.cli,
    ),
  ).rejects.toThrow();
  expect(readFileSync(join(f.dir, "victim.txt"), "utf8")).toBe("preserve outside file");
});
