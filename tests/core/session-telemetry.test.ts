import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPathToHistoryDir } from "../../src/core/agents/claude/claude-history.js";
import { readSessionTelemetry } from "../../src/core/session/session-telemetry.js";
import type { AgentKind } from "../../src/shared/types.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

let stateDir: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tcb-telemetry-state-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
});

const claudeLine = (type: "user" | "assistant", content: string, timestamp: string): string =>
  JSON.stringify({ timestamp, type, message: { content } });

describe("readSessionTelemetry", () => {
  it("combines running, queue, and cwd drift behind one read model", async () => {
    const deps = fakeDeps({
      configResolver: { detectAgentKind: vi.fn(async (): Promise<AgentKind> => "codex") },
      queueSize: 1,
      bridge: { paneCurrentPath: vi.fn(async () => "/work/other") },
      agent: { checkIfRunning: vi.fn(async () => true) },
    });

    await expect(
      readSessionTelemetry(deps, "tmux_proj_app", {
        boundPath: "/work/app",
        includePathDrift: true,
      }),
    ).resolves.toMatchObject({
      agentKind: "codex",
      agentRunning: true,
      queueBusy: true,
      busy: true,
      pathDrifted: true,
    });
  });

  it("reads transcript activity and latest assistant turn through the agent profile", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "tcb-telemetry-cfg-"));
    const projectPath = mkdtempSync(join(tmpdir(), "tcb-telemetry-proj-"));
    const historyDir = projectPathToHistoryDir(projectPath, configRoot);
    mkdirSync(historyDir, { recursive: true });
    const startedAt = "2026-07-04T10:00:00.000Z";
    writeFileSync(
      join(historyDir, "11111111-1111-1111-1111-111111111111.jsonl"),
      `${claudeLine("user", "build it", startedAt)}\n${claudeLine(
        "assistant",
        "done",
        "2026-07-04T10:00:03.000Z",
      )}\n`,
    );
    const now = Date.parse(startedAt) + 5_000;
    const deps = fakeDeps({
      configResolver: {
        detectAgentKind: vi.fn(async (): Promise<AgentKind> => "claude"),
        resolveConfigRoot: vi.fn(async () => configRoot),
        resolveLiveTranscript: vi.fn(async () => null),
      },
      agent: { checkIfRunning: vi.fn(async () => true) },
    });

    const telemetry = await readSessionTelemetry(deps, "tmux_proj_app", {
      boundPath: projectPath,
      now,
      activityWindowMs: 60_000,
      includeLatestAssistant: true,
      includeCurrentTurn: true,
    });

    expect(telemetry.transcriptBusy).toBe(true);
    expect(telemetry.latestAssistant).toBe("done");
    expect(telemetry.currentTurnStartedAt).toBe(Date.parse(startedAt));

    rmSync(configRoot, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  });
});
