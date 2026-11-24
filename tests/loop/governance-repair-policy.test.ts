import { describe, expect, it } from "vitest";
import {
  parseSupervisorFinalSummaryJson,
  validateSupervisorFinalSummaryForWorkOrder,
} from "../../src/core/loop/final-summary-contract.js";
import { runSupervisedSystemGateOutcome } from "../../src/core/loop/service.js";
import type {
  LoopSupervisorFinalSummary,
  LoopWorkOrder,
} from "../../src/core/loop/work-order-contract.js";

const workOrder = {
  task: { kind: "automation-governance-review", allowRepairPr: true },
  governance: {
    repair: { allowPullRequest: true, autoMerge: false, minimumSeverity: "P1", maxPullRequests: 1 },
  },
} as LoopWorkOrder;

function summary(decisions: unknown[] = []): LoopSupervisorFinalSummary {
  return {
    status: "completed",
    projectId: "hub",
    actionsTaken: [],
    delegatedTasks: [],
    finalVerification: "passed",
    commits: [],
    followUps: [],
    pullRequestDecisions: decisions,
  } as LoopSupervisorFinalSummary;
}
function decision(severity: unknown = "P1", number = 1) {
  return {
    number,
    repository: "example/hub",
    outcome: "retry",
    severity,
    evidence: ["Confirmed scheduler contract violation; repair PR remains open"],
    nextStep: "Owner review",
  };
}

describe("governance repair policy", () => {
  it.each(["P0", "P1"])("preserves authorized %s severity through normalization", (severity) => {
    const parsed = parseSupervisorFinalSummaryJson(
      workOrder,
      JSON.stringify(summary([decision(severity)])),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.summary.pullRequestDecisions?.[0]).toHaveProperty("severity", severity);
  });
  it.each([undefined, "P2", "P3", "critical", 1, null])(
    "rejects missing, disallowed or malformed severity %s",
    (severity) => {
      const value = { ...decision(), severity };
      expect(parseSupervisorFinalSummaryJson(workOrder, JSON.stringify(summary([value]))).ok).toBe(
        false,
      );
    },
  );
  it("blocks system publication when repair commits omit severity decisions", () => {
    const commands: string[] = [];
    const outcome = runSupervisedSystemGateOutcome({
      project: {
        id: "hub",
        name: "Hub",
        path: "/tmp/hub",
        commit: { enabled: false, perRound: false },
        pullRequest: {
          enabled: true,
          base: "dev",
          switchBack: "dev",
          autoMerge: false,
          mergeMethod: "squash",
        },
      },
      workOrder: {
        ...workOrder,
        id: "run-governance",
        projectId: "hub",
        projectName: "Hub",
        projectPath: "/tmp/hub",
        verificationCommands: [],
        commitPolicy: { enabled: false, perRound: false },
      } as LoopWorkOrder,
      result: {
        status: "completed",
        output: "",
        summary: {
          ...summary(),
          commits: ["a".repeat(40)],
          reviewGate: {
            preMutationReview: [],
            postMutationReview: [],
            aiReview: "passed",
            deterministicGates: [],
            decision: "pass",
            notes: [],
          },
        },
      },
      runGit: (invocation) => ({ ...invocation, status: 0, stdout: "", stderr: "" }),
      runCommand: (invocation) => {
        commands.push(invocation.command);
        return { ...invocation, status: 0, stdout: "", stderr: "" };
      },
    });
    expect(outcome.failures).toContain(
      "governance repair commits require a structured PR decision with severity",
    );
    expect(outcome.result.status).toBe("supervisor-failed");
    expect(commands.some((command) => command.includes("pr create"))).toBe(false);
  });
  it.each(["missing", "foreign", "matching"])(
    "binds governance repair evidence to the observed PR (%s)",
    (kind) => {
      const commands: string[] = [];
      const outcome = runSupervisedSystemGateOutcome({
        project: {
          id: "hub",
          name: "Hub",
          path: "/tmp/hub",
          commit: { enabled: true, perRound: false },
          pullRequest: {
            enabled: true,
            base: "dev",
            switchBack: "dev",
            autoMerge: false,
            mergeMethod: "squash",
          },
        },
        workOrder: {
          ...workOrder,
          id: "run-governance",
          projectId: "hub",
          projectName: "Hub",
          projectPath: "/tmp/hub",
          verificationCommands: [],
          commitPolicy: { enabled: true, perRound: false, branch: "loop/hub/governance/run" },
        } as LoopWorkOrder,
        result: {
          status: "completed",
          output: "",
          summary: {
            ...summary([decision()]),
            commits: ["a".repeat(40)],
            reviewGate: {
              preMutationReview: [],
              postMutationReview: [],
              aiReview: "passed",
              deterministicGates: [],
              decision: "pass",
              notes: [],
            },
          },
        },
        runGit: (invocation) => ({
          ...invocation,
          status: 0,
          stdout:
            invocation.args[0] === "branch" ? "dev" : invocation.args[0] === "rev-list" ? "1" : "",
          stderr: "",
        }),
        runCommand: (invocation) => {
          commands.push(invocation.command);
          return {
            ...invocation,
            status: kind === "missing" ? 1 : 0,
            stdout:
              kind === "missing"
                ? ""
                : JSON.stringify({
                    url: `https://github.com/${kind === "foreign" ? "other/repo/pull/2" : "example/hub/pull/1"}`,
                    state: "OPEN",
                    mergeable: "MERGEABLE",
                    statusCheckRollup: [],
                    body: "Repair the confirmed scheduler violation.",
                    files: [],
                    commits: [{ oid: "a".repeat(40) }],
                  }),
            stderr: kind === "missing" ? "no pull requests found for branch" : "",
          };
        },
      });
      expect(commands.some((command) => command.includes("pr create"))).toBe(false);
      if (kind === "matching") {
        expect(outcome.failures.some((failure) => failure.includes("governance repair PR"))).toBe(
          false,
        );
      } else {
        expect(outcome.failures).toContain(
          "governance repair PR identity is missing or does not match its severity decision",
        );
      }
    },
  );
  it("rejects multiple repair PRs, including duplicate declarations", () => {
    for (const number of [1, 2]) {
      expect(
        validateSupervisorFinalSummaryForWorkOrder(
          workOrder,
          summary([decision(), decision("P0", number)]),
        ),
      ).toBe(false);
    }
  });
  it("rejects repair PRs when the task or structured policy prohibits them", () => {
    for (const order of [
      { ...workOrder, task: { ...workOrder.task, allowRepairPr: false } },
      {
        ...workOrder,
        governance: { repair: { ...workOrder.governance?.repair, allowPullRequest: false } },
      },
    ]) {
      expect(
        validateSupervisorFinalSummaryForWorkOrder(order as LoopWorkOrder, summary([decision()])),
      ).toBe(false);
    }
  });
  it("rejects merged governance repairs even in blocked summaries", () => {
    expect(
      validateSupervisorFinalSummaryForWorkOrder(workOrder, {
        ...summary([{ ...decision(), outcome: "merged" }]),
        status: "blocked",
      }),
    ).toBe(false);
  });
  it("accepts read-only governance reports and legacy task policy", () => {
    expect(validateSupervisorFinalSummaryForWorkOrder(workOrder, summary())).toBe(true);
    const { governance: _governance, ...legacyWorkOrder } = workOrder;
    expect(validateSupervisorFinalSummaryForWorkOrder(legacyWorkOrder, summary([decision()]))).toBe(
      true,
    );
  });
  it("keeps ordinary repository reviews compatible without severity", () => {
    const { severity: _severity, ...ordinary } = decision();
    expect(
      parseSupervisorFinalSummaryJson(
        { task: { kind: "repository-pull-request-review" } } as LoopWorkOrder,
        JSON.stringify({ ...summary([ordinary]), status: "blocked" }),
      ).ok,
    ).toBe(true);
  });
});
