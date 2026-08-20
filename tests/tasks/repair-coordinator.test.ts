import { afterEach, describe, expect, it } from "vitest";
import {
  createRepairDedupeKey,
  InMemoryRepairQueueStore,
  RepairCoordinator,
} from "../../src/core/tasks/repair-coordinator.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("RepairCoordinator", () => {
  it("deduplicates equivalent failures while preserving linked task IDs", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const first = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "daily-audit",
      taskFamily: "active-delegated-task",
      fingerprint: "invalid-final-summary",
      taskId: "task-1",
      summary: "first failure",
      now: 1_000,
    });
    const second = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "runtime-guardian",
      taskFamily: "active-delegated-task",
      fingerprint: "invalid-final-summary",
      taskId: "task-2",
      summary: "same logical failure",
      now: 2_000,
    });

    expect(second.id).toBe(first.id);
    expect(second.linkedTaskIds).toEqual(["task-1", "task-2"]);
    expect(coordinator.list()).toHaveLength(1);
    expect(createRepairDedupeKey(second)).toContain("active-delegated-task");
  });

  it("keeps one active runtime repair when diagnostic evidence formatting changes", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const first = coordinator.enqueue({
      projectId: "fluent-frame",
      projectPath: "/repo/fluent-frame",
      source: "runtime-guardian",
      taskFamily: "terminal-system-gate-failure",
      fingerprint: "gate failed | artifact exists",
      taskId: "run-1",
      summary: "gate failed; artifact exists",
      now: 1_000,
    });
    const rediscovered = coordinator.enqueue({
      projectId: "fluent-frame",
      projectPath: "/repo/fluent-frame",
      source: "runtime-guardian",
      taskFamily: "terminal-system-gate-failure",
      fingerprint: "gate failed; artifact exists",
      taskId: "run-1",
      summary: "gate failed; artifact exists",
      now: 2_000,
    });

    expect(rediscovered.id).toBe(first.id);
    expect(rediscovered.status).toBe("pending");
    expect(coordinator.list()).toHaveLength(1);
  });

  it("reopens a recoverable blocked project recovery for the same configured target", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const stale = coordinator.enqueue({
      projectId: "net-auto-switch-all-prs",
      projectPath: "/repo/net-auto-switch",
      source: "project-recovery",
      taskFamily: "repository-pull-request-review",
      fingerprint: "old invalid final summary",
      taskId: "autopilot:old-net-auto-switch",
      summary:
        "Authoritative supervisor final summary reports incomplete recovery (status=blocked).",
      now: 1_000,
    });
    coordinator.markTerminal(stale.id, "blocked", 1_500);

    const reopened = coordinator.enqueue({
      projectId: "net-auto-switch-all-prs",
      projectPath: "/repo/net-auto-switch",
      source: "project-recovery",
      taskFamily: "net-auto-switch active delegated task",
      fingerprint: "supervisor completion evidence is invalid or incomplete and can be retried",
      taskId: "autopilot:new-net-auto-switch",
      summary:
        "Recovery classification: needs-owner-decision; configured project is unavailable or ambiguous. supervisor completion evidence is invalid or incomplete and can be retried",
      now: 2_000,
    });

    expect(reopened.id).toBe(stale.id);
    expect(reopened).toMatchObject({
      status: "pending",
      attempt: 0,
      nextAttemptAt: 2_000,
    });
    expect(reopened.linkedTaskIds).toEqual([
      "autopilot:old-net-auto-switch",
      "autopilot:new-net-auto-switch",
    ]);
    expect(coordinator.list()).toHaveLength(1);
  });

  it("keeps owner-decision project recovery blocks terminal", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const terminal = coordinator.enqueue({
      projectId: "alcove",
      projectPath: "/repo/alcove",
      source: "project-recovery",
      taskFamily: "active delegated task",
      fingerprint: "requires project owner decision",
      taskId: "autopilot:old-alcove",
      summary: "Recovery classification: needs-owner-decision; evidence requires a project-owner.",
      now: 1_000,
    });
    coordinator.markTerminal(terminal.id, "blocked", 1_500);

    const next = coordinator.enqueue({
      projectId: "alcove",
      projectPath: "/repo/alcove",
      source: "project-recovery",
      taskFamily: "active delegated task",
      fingerprint: "requires project owner decision",
      taskId: "autopilot:new-alcove",
      summary: "Recovery classification: needs-owner-decision; evidence requires a project-owner.",
      now: 2_000,
    });

    expect(next.id).not.toBe(terminal.id);
    expect(coordinator.list()).toHaveLength(2);
    expect(coordinator.list().find((record) => record.id === terminal.id)).toMatchObject({
      status: "blocked",
    });
  });

  it("keeps accepted blocked project recovery closures terminal for the same task", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const terminal = coordinator.enqueue({
      projectId: "knowledge-engine",
      projectPath: "/repo/knowledge-engine",
      source: "project-recovery",
      taskFamily: "knowledge-engine active delegated task",
      fingerprint: "active delegation ended with blocked",
      taskId: "autopilot:knowledge-engine",
      summary:
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
      now: 1_000,
    });
    coordinator.markTerminal(terminal.id, "blocked", 1_500);

    const next = coordinator.enqueue({
      projectId: "knowledge-engine",
      projectPath: "/repo/knowledge-engine",
      source: "project-recovery",
      taskFamily: "knowledge-engine active delegated task",
      fingerprint: "active delegation ended with blocked",
      taskId: "autopilot:knowledge-engine",
      summary: "Recovery dispatch deferred: automation admission deferred: capacity-exhausted",
      now: 2_000,
    });

    expect(next.id).not.toBe(terminal.id);
    expect(coordinator.list()).toHaveLength(2);
    expect(coordinator.list().find((record) => record.id === terminal.id)).toMatchObject({
      status: "blocked",
    });
  });

  it("keeps accepted blocked project recovery closures terminal for later tasks in the same project", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const terminal = coordinator.enqueue({
      projectId: "knowledge-engine",
      projectPath: "/repo/knowledge-engine",
      source: "project-recovery",
      taskFamily: "knowledge-engine active delegated task",
      fingerprint: "active delegation ended with blocked",
      taskId: "autopilot:old-knowledge-engine",
      summary:
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
      now: 1_000,
    });
    coordinator.markTerminal(terminal.id, "blocked", 1_500);

    const next = coordinator.enqueue({
      projectId: "knowledge-engine",
      projectPath: "/repo/knowledge-engine",
      source: "project-recovery",
      taskFamily: "knowledge-engine active delegated task",
      fingerprint: "supervisor completion evidence is invalid or incomplete and can be retried",
      taskId: "autopilot:new-knowledge-engine",
      summary:
        "Recovery classification: needs-owner-decision; configured project is unavailable or ambiguous. supervisor completion evidence is invalid or incomplete and can be retried",
      now: 2_000,
    });

    expect(next.id).not.toBe(terminal.id);
    expect(coordinator.list()).toHaveLength(2);
    expect(coordinator.list().find((record) => record.id === terminal.id)).toMatchObject({
      status: "blocked",
    });
  });

  it("claims due items in priority order and leaves later items pending", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    coordinator.enqueue({
      projectId: "project-a",
      projectPath: "/repo/a",
      source: "loop-engineering",
      taskFamily: "architecture",
      fingerprint: "old",
      taskId: "old",
      summary: "old",
      priority: 10,
      now: 1_000,
    });
    coordinator.enqueue({
      projectId: "project-b",
      projectPath: "/repo/b",
      source: "daily-audit",
      taskFamily: "audit",
      fingerprint: "new",
      taskId: "new",
      summary: "new",
      priority: 100,
      now: 2_000,
    });

    const claimed = coordinator.claimDue({ now: 3_000, leaseId: "lease-1", limit: 1 });

    expect(claimed.map((item) => item.linkedTaskIds)).toEqual([["new"]]);
    expect(coordinator.list().find((item) => item.linkedTaskIds.includes("new"))).toMatchObject({
      status: "leased",
      leaseId: "lease-1",
    });
    expect(coordinator.list().find((item) => item.linkedTaskIds.includes("old"))).toMatchObject({
      status: "pending",
    });
  });

  it("scopes claims so consumers cannot steal another repair source", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "runtime-guardian",
      taskFamily: "runtime",
      fingerprint: "runtime-failure",
      taskId: "runtime-1",
      now: 1_000,
    });
    coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "daily-audit",
      taskFamily: "audit",
      fingerprint: "audit-failure",
      taskId: "audit-1",
      now: 1_001,
    });

    const claimed = coordinator.claimDue({
      now: 2_000,
      leaseId: "daily-audit-lease",
      limit: 8,
      projectId: "tmux-claude-bot",
      excludeSources: ["runtime-guardian"],
    });

    expect(claimed.map((item) => item.source)).toEqual(["daily-audit"]);
    expect(coordinator.list().find((item) => item.source === "runtime-guardian")).toMatchObject({
      status: "pending",
    });
  });

  it("requeues an expired lease with bounded retry backoff", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    coordinator.enqueue({
      projectId: "project-a",
      projectPath: "/repo/a",
      source: "daily-audit",
      taskFamily: "audit",
      fingerprint: "timeout",
      taskId: "task-1",
      summary: "timeout",
      now: 1_000,
    });
    coordinator.claimDue({ now: 2_000, leaseId: "lease-1", leaseMs: 100, limit: 1 });

    expect(coordinator.reconcileExpiredLeases(2_101)).toBe(1);
    expect(coordinator.list()[0]).toMatchObject({
      status: "retry-wait",
      attempt: 1,
      nextAttemptAt: 2_101 + 30_000,
    });
    expect(coordinator.claimDue({ now: 2_102, leaseId: "lease-2", limit: 1 })).toEqual([]);
  });

  it("dead-letters a repair after the shared retry limit instead of scheduling forever", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const item = coordinator.enqueue({
      projectId: "project-a",
      projectPath: "/repo/a",
      source: "runtime-guardian",
      taskFamily: "terminal-system-gate-failure",
      fingerprint: "persistent-failure",
      taskId: "run-1",
      now: 1_000,
    });

    let now = 2_000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(
        coordinator.claimIds([item.id], { now, leaseId: `lease-${attempt}`, limit: 1 }),
      ).toHaveLength(1);
      coordinator.releaseForRetry(item.id, now + 1);
      now += 2_000_000;
    }

    expect(coordinator.list()[0]).toMatchObject({ status: "dead-letter", attempt: 3 });
    expect(coordinator.claimDue({ now: now + 2_000_000, leaseId: "too-late", limit: 1 })).toEqual(
      [],
    );
  });

  it("dead-letters an exhausted persisted repair before a consumer can reclaim it", () => {
    const store = new InMemoryRepairQueueStore();
    store.set("repair-legacy", {
      id: "repair-legacy",
      dedupeKey: "project-a|/repo/a|terminal-system-gate-failure|legacy",
      projectId: "project-a",
      projectPath: "/repo/a",
      source: "runtime-guardian",
      taskFamily: "terminal-system-gate-failure",
      fingerprint: "legacy",
      linkedTaskIds: ["run-legacy"],
      summaries: ["legacy retry"],
      status: "retry-wait",
      priority: 100,
      attempt: 14,
      createdAt: 1_000,
      updatedAt: 2_000,
      nextAttemptAt: 3_000,
    });
    const coordinator = new RepairCoordinator(store);

    expect(coordinator.claimDue({ now: 4_000, leaseId: "new", limit: 1 })).toEqual([]);
    expect(coordinator.list()[0]).toMatchObject({ status: "dead-letter", attempt: 14 });
  });

  it("imports bot-owned historical failures but does not claim unrelated projects", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const imported = coordinator.importPending(
      [
        {
          taskId: "loop:bot:1",
          source: "loop-engineering",
          name: "tmux-claude-bot architecture",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "pending",
          summary: "old bot failure",
          updatedAt: 1,
        },
        {
          taskId: "loop:geo:1",
          source: "loop-engineering",
          name: "geo-backend architecture",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "pending",
          summary: "target project failure",
          updatedAt: 1,
        },
      ],
      { projectId: "tmux-claude-bot", projectPath: "/repo/tmux-claude-bot", now: 2_000 },
    );

    expect(imported).toBe(1);
    expect(coordinator.list()).toHaveLength(1);
    expect(coordinator.list()[0]?.linkedTaskIds).toEqual(["loop:bot:1"]);
  });

  it("does not import a configured project whose name only shares the bot prefix", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const imported = coordinator.importPending(
      [
        {
          taskId: "loop:all-prs:1",
          source: "loop-engineering",
          name: "tmux-claude-bot-all-prs repository-pull-request-review",
          scheduledAt: 1,
          status: "failed",
          repairStatus: "pending",
          summary: "dispatch-failed",
          updatedAt: 1,
        },
      ],
      { projectId: "tmux-claude-bot", projectPath: "/repo/tmux-claude-bot", now: 2_000 },
    );

    expect(imported).toBe(0);
    expect(coordinator.list()).toEqual([]);
  });

  it("reconciles terminal ledger outcomes and supports explicit retry release", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const item = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "daily-audit",
      taskFamily: "audit",
      fingerprint: "failure",
      taskId: "task-1",
      now: 1_000,
    });
    coordinator.claimIds([item.id], { now: 2_000, leaseId: "lease", limit: 1 });
    expect(coordinator.markRunning(item.id, "wrong-lease", 2_001)).toBeUndefined();
    expect(coordinator.markRunning(item.id, "lease", 2_001)).toMatchObject({ status: "running" });
    expect(
      coordinator.reconcileFromLedger([{ taskId: "task-1", repairStatus: "fixed" }], 3_000),
    ).toBe(1);
    expect(coordinator.list()[0]).toMatchObject({ status: "fixed" });

    const retry = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "daily-audit",
      taskFamily: "other",
      fingerprint: "failure",
      taskId: "task-2",
      now: 4_000,
    });
    coordinator.claimIds([retry.id], { now: 4_000, leaseId: "lease-2", limit: 1 });
    expect(coordinator.releaseForRetry(retry.id, 4_001)).toMatchObject({
      status: "retry-wait",
      attempt: 1,
    });
    expect(coordinator.markTerminal(retry.id, "blocked", 4_002)).toMatchObject({
      status: "blocked",
    });
  });

  it("closes pending duplicates after every linked ledger outcome is terminal", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const item = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "active-delegated-task",
      fingerprint: "invalid-final-summary",
      taskId: "task-1",
      now: 1_000,
    });
    coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "active-delegated-task",
      fingerprint: "invalid-final-summary",
      taskId: "task-2",
      now: 1_001,
    });

    expect(
      coordinator.reconcileFromLedger(
        [
          { taskId: "task-1", repairStatus: "fixed" },
          { taskId: "task-2", repairStatus: "superseded" },
        ],
        2_000,
      ),
    ).toBe(1);
    expect(coordinator.list()).toEqual([expect.objectContaining({ id: item.id, status: "fixed" })]);
  });

  it("treats not-needed ledger outcomes as terminal queue cleanup", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const item = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "active-delegated-task",
      fingerprint: "historical-recovery",
      taskId: "task-success",
      now: 1_000,
    });

    expect(
      coordinator.reconcileFromLedger(
        [{ taskId: "task-success", repairStatus: "not-needed" }],
        2_000,
      ),
    ).toBe(1);
    expect(coordinator.list()).toEqual([expect.objectContaining({ id: item.id, status: "fixed" })]);
  });

  it("blocks stale queues when a linked historical task is missing but known outcomes are terminal", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const item = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "active-delegated-task",
      fingerprint: "historical-recovery",
      taskId: "task-known",
      now: 1_000,
    });
    coordinator.linkTaskIds(item.id, ["task-missing"], 1_001);

    expect(
      coordinator.reconcileFromLedger([{ taskId: "task-known", repairStatus: "blocked" }], 2_000),
    ).toBe(1);
    expect(coordinator.list()).toEqual([expect.objectContaining({ status: "blocked" })]);
  });

  it("keeps recovery queues open when a linked recovery task is still settling", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const item = coordinator.enqueue({
      projectId: "net-auto-switch-all-prs",
      projectPath: "/repo/net-auto-switch",
      source: "project-recovery",
      taskFamily: "repository-pull-request-review",
      fingerprint: "invalid-final-summary",
      taskId: "autopilot:old-net-auto-switch",
      now: 1_000,
    });
    coordinator.linkTaskIds(item.id, ["autopilot:running-net-auto-switch"], 1_001);

    expect(
      coordinator.reconcileFromLedger(
        [
          { taskId: "autopilot:old-net-auto-switch", repairStatus: "blocked" },
          { taskId: "autopilot:running-net-auto-switch", status: "running" },
        ],
        2_000,
      ),
    ).toBe(0);
    expect(coordinator.list()).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("supersedes duplicate active repairs for the same task in favor of project recovery", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const botRepair = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "loop-engineering",
      taskFamily: "repository-pull-request-review",
      fingerprint: "dispatch-failed",
      taskId: "task-duplicate",
      now: 1_000,
    });
    coordinator.claimIds([botRepair.id], { now: 1_001, leaseId: "bot", limit: 1 });
    const projectRepair = coordinator.enqueue({
      projectId: "target-project",
      projectPath: "/repo/target-project",
      source: "project-recovery",
      taskFamily: "repository-pull-request-review",
      fingerprint: "dispatch-failed",
      taskId: "task-duplicate",
      now: 1_002,
    });
    coordinator.claimIds([projectRepair.id], { now: 1_003, leaseId: "project", limit: 1 });

    expect(coordinator.reconcileDuplicateTaskIds(2_000)).toBe(1);
    expect(coordinator.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: botRepair.id, status: "superseded" }),
        expect.objectContaining({ id: projectRepair.id, status: "leased" }),
      ]),
    );
  });

  it("keeps aggregate repair findings that share only a derived WorkOrder task ID", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const fluent = coordinator.enqueue({
      projectId: "fluent-frame",
      projectPath: "/repo/fluent-frame",
      source: "runtime-guardian",
      taskFamily: "terminal-system-gate-failure",
      fingerprint: "fluent failure",
      taskId: "run-fluent",
      now: 1_000,
    });
    const english = coordinator.enqueue({
      projectId: "english-pilot",
      projectPath: "/repo/english-pilot",
      source: "runtime-guardian",
      taskFamily: "terminal-invalid-output",
      fingerprint: "english failure",
      taskId: "run-english",
      now: 1_001,
    });
    coordinator.claimIds([fluent.id, english.id], {
      now: 1_002,
      leaseId: "aggregate",
      limit: 2,
    });
    coordinator.markRunning(fluent.id, "aggregate", 1_003);
    coordinator.markRunning(english.id, "aggregate", 1_003);
    coordinator.attachWorkOrder(fluent.id, "aggregate-repair", 1_004);
    coordinator.attachWorkOrder(english.id, "aggregate-repair", 1_004);
    coordinator.linkTaskIds(fluent.id, ["autopilot:aggregate-repair"], 1_002);
    coordinator.linkTaskIds(english.id, ["autopilot:aggregate-repair"], 1_002);

    expect(coordinator.reconcileDuplicateTaskIds(2_000)).toBe(0);
    expect(coordinator.list()).toEqual([
      expect.objectContaining({ id: fluent.id, status: "running" }),
      expect.objectContaining({ id: english.id, status: "running" }),
    ]);

    coordinator.releaseForRetry(fluent.id, 2_001, { detachWorkOrder: true });
    coordinator.releaseForRetry(english.id, 2_001, { detachWorkOrder: true });
    expect(coordinator.reconcileDuplicateTaskIds(2_002)).toBe(0);
    expect(coordinator.list()).toEqual([
      expect.objectContaining({ id: fluent.id, status: "retry-wait" }),
      expect.objectContaining({ id: english.id, status: "retry-wait" }),
    ]);
    expect(coordinator.list().every((record) => record.workOrderId === undefined)).toBe(true);
  });

  it("supersedes a stale terminal project-recovery record when the same task reopens", () => {
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const first = coordinator.enqueue({
      projectId: "alcove",
      projectPath: "/repo/alcove",
      source: "project-recovery",
      taskFamily: "architecture",
      fingerprint: "handoff",
      taskId: "task-1",
      now: 1_000,
    });
    coordinator.markTerminal(first.id, "blocked", 1_100);
    const reopened = coordinator.enqueue({
      projectId: "alcove",
      projectPath: "/repo/alcove",
      source: "project-recovery",
      taskFamily: "architecture",
      fingerprint: "handoff",
      taskId: "task-1",
      now: 2_000,
    });

    expect(reopened.id).toBe(first.id);
    expect(coordinator.list().find((item) => item.id === first.id)?.status).toBe("pending");
  });
});
