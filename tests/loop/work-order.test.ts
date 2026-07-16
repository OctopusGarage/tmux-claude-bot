import { describe, expect, it } from "vitest";
import { parseLoopConfigYaml } from "../../src/core/loop/config.js";
import {
  buildLoopSupervisorPrompt,
  buildLoopWorkOrder,
  finalMarkerForWorkOrder,
  parseSupervisorFinalSummary,
} from "../../src/core/loop/work-order.js";

const config = parseLoopConfigYaml(`
skills:
  approved:
    - id: improve-codebase-architecture
      sourceUrl: https://github.com/mattpocock/skills
      sourcePath: skills/engineering/improve-codebase-architecture
      ref: 082131022ca026f353ab74d9a6e1dcc11adbd954
      checksum: sha256:abc
      platforms: [codex]
      tags: [architecture]
      trustLevel: approved
      risk: medium
      updatePolicy: notify
projects:
  - id: datavibe
    name: Datavibe
    path: /repo/datavibe
    agent: codex
    schedule: "30 5 * * *"
    runner:
      kind: agent-supervised
      timeoutMs: 7200000
      maxTurns: 20
    goal: Improve architecture.
    maxRounds: 3
    targetScore: 90
    assessment:
      command: npm run assess
    execution:
      agent: true
    allowedActions: [tests, docs, small-refactor]
    blockedActions: [direct-model-api, dependency-upgrade, broad-rewrite]
`);

function firstProject() {
  const project = config.projects[0];
  if (project === undefined) throw new Error("expected test config project");
  return project;
}

describe("loop supervisor work order", () => {
  it("builds a bounded work order from project config", () => {
    const project = firstProject();
    const workOrder = buildLoopWorkOrder({
      config,
      project,
      scheduledAt: Date.parse("2026-07-16T05:30:00Z"),
      runId: "1752643800000-datavibe",
    });

    expect(workOrder).toMatchObject({
      id: "1752643800000-datavibe",
      projectId: "datavibe",
      projectPath: "/repo/datavibe",
      agent: "codex",
      maxRounds: 3,
      targetScore: 90,
      runner: {
        kind: "agent-supervised",
        timeoutMs: 7200000,
        maxTurns: 20,
        requireConfirmation: false,
      },
      requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:1752643800000-datavibe]",
    });
    expect(workOrder.skills.approved[0]?.id).toBe("improve-codebase-architecture");
  });

  it("renders a prompt with policy, commands, and the final marker", () => {
    const workOrder = buildLoopWorkOrder({
      config,
      project: firstProject(),
      scheduledAt: 1752643800000,
      runId: "1752643800000-datavibe",
    });

    const prompt = buildLoopSupervisorPrompt(workOrder);

    expect(prompt).toContain("You are the Loop Supervisor for tmux-claude-bot.");
    expect(prompt).toContain("Do not call model-provider APIs.");
    expect(prompt).toContain('tcb send <project> "<task>"');
    expect(prompt).toContain("tcb dashboard --json");
    expect(prompt).not.toContain("tcb status");
    expect(prompt).toContain(finalMarkerForWorkOrder("1752643800000-datavibe"));
  });

  it("parses the final marker and JSON summary", () => {
    const result = parseSupervisorFinalSummary(
      [
        "done",
        "[LOOP_SUPERVISOR_DONE:wo-1]",
        '{"status":"completed","projectId":"datavibe","actionsTaken":["verified"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
      ].join("\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.status).toBe("completed");
      expect(result.summary.finalVerification).toBe("passed");
    }
  });

  it("parses the JSON summary after the last matching final marker", () => {
    const marker = "[LOOP_SUPERVISOR_DONE:wo-1]";
    const result = parseSupervisorFinalSummary(
      [
        "earlier transcript echoed the marker",
        marker,
        '{"status":"failed","projectId":"datavibe","actionsTaken":[],"delegatedTasks":[],"finalVerification":"failed","commits":[],"followUps":[]}',
        "real final summary follows",
        marker,
        '{"status":"completed","projectId":"datavibe","actionsTaken":["verified"],"delegatedTasks":[],"finalVerification":"passed","commits":["abc123"],"followUps":[]}',
      ].join("\n"),
      "wo-1",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.status).toBe("completed");
      expect(result.summary.commits).toEqual(["abc123"]);
    }
  });

  it("rejects a summary with an invalid status", () => {
    expect(
      parseSupervisorFinalSummary(
        [
          "[LOOP_SUPERVISOR_DONE:wo-1]",
          '{"status":"done","projectId":"datavibe","actionsTaken":[],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":[]}',
        ].join("\n"),
        "wo-1",
      ),
    ).toEqual({
      ok: false,
      reason: "invalid-summary",
    });
  });

  it("rejects output without the expected final marker", () => {
    expect(parseSupervisorFinalSummary("{}", "wo-1")).toEqual({
      ok: false,
      reason: "missing-final-marker",
    });
  });
});
