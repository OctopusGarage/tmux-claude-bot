import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentActivitySnapshot } from "../../src/core/agents/activity-snapshot.js";
import { clearTaskTiming, taskEnded, taskStarted } from "../../src/core/session/task-timing.js";
import type { AgentKind } from "../../src/shared/types.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

let stateDir: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tcb-agent-activity-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  clearTaskTiming("tmux_proj_app");
  delete process.env.TCB_STATE_DIR;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

describe("readAgentActivitySnapshot", () => {
  it("derives queue task identity, duration, and cumulative busy time behind one interface", async () => {
    const startedAt = 1_000;
    const now = 4_500;
    taskStarted("tmux_proj_app", startedAt);
    const deps = fakeDeps({
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "codex") },
      queue: {
        getCurrentSessionMessage: vi.fn((session: string) =>
          session === "tmux_proj_app" ? ({ id: "msg-7" } as never) : undefined,
        ),
      },
    });

    await expect(
      readAgentActivitySnapshot(deps, "tmux_proj_app", {
        now,
        agentKindMode: "live",
        agentRunningMode: "live-kind",
      }),
    ).resolves.toMatchObject({
      kind: "codex",
      running: true,
      busy: true,
      taskMs: 3_500,
      task: { key: "queue:msg-7", startedAt, source: "queue" },
      cumulativeBusyMs: 3_500,
    });
  });

  it("keeps completed task time cumulative without inventing a current task", async () => {
    taskStarted("tmux_proj_app", 1_000);
    taskEnded("tmux_proj_app", 4_000);
    const deps = fakeDeps({
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude") },
    });

    const snap = await readAgentActivitySnapshot(deps, "tmux_proj_app", {
      now: 5_000,
      includeQueue: false,
      agentKindMode: "live",
      agentRunningMode: "live-kind",
    });

    expect(snap.busy).toBe(false);
    expect(snap.task).toBeUndefined();
    expect(snap.taskMs).toBeUndefined();
    expect(snap.cumulativeBusyMs).toBe(3_000);
  });
});
