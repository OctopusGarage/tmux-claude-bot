import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAutomationAdmissionEvent } from "../../../src/core/automation/admission-events.js";
import { runAgentCapacityCommand } from "../../../src/core/automation/capacity-command.js";
import { AgentCapacityStore } from "../../../src/core/automation/capacity-store.js";

const originalStateDir = process.env.TCB_STATE_DIR;
let stateDir: string;
const now = Date.UTC(2026, 7, 13, 12, 0, 0);

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tcb-capacity-command-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("agent capacity command", () => {
  it("renders safe typed status for both supported agent pools", () => {
    new AgentCapacityStore().recordObservation({
      agent: "codex",
      authentication: "subscription",
      state: "constrained",
      fiveHourPct: 92,
      weeklyPct: 40,
      resetAt: null,
      observedAt: now,
      nextProbeAt: now + 60_000,
      latestReason: "usage-constrained",
    });

    const result = runAgentCapacityCommand(["status", "--json"], { now: () => now });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout ?? "") as { agents: unknown[] };
    expect(parsed.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: "codex",
          authentication: "subscription",
          state: "constrained",
          fiveHourPct: 92,
        }),
        expect.objectContaining({ agent: "claude", state: "unknown" }),
      ]),
    );
    expect(result.stdout).not.toContain(process.env.HOME ?? "<missing-home>");
  });

  it("renders bounded decision history and validates the lookback", () => {
    appendAutomationAdmissionEvent({
      at: now - 60_000,
      kind: "deferred",
      source: "loop-engineering",
      intentId: "project-a:architecture",
      agent: "codex",
      reason: "capacity-constrained",
    });

    const result = runAgentCapacityCommand(["history", "--since", "2h", "--json"], {
      now: () => now,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toMatchObject({
      events: [expect.objectContaining({ reason: "capacity-constrained" })],
      truncated: false,
    });
    expect(
      runAgentCapacityCommand(["history", "--since", "31d"], { now: () => now }),
    ).toMatchObject({ exitCode: 1 });
  });
});
