import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAutomationAdmissionEvent,
  readAutomationAdmissionEvents,
} from "../../../src/core/automation/admission-events.js";

const originalStateDir = process.env.TCB_STATE_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tcb-admission-events-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("automation admission event journal", () => {
  it("persists bounded structured decisions and suppresses repeated tick noise", () => {
    appendAutomationAdmissionEvent({
      at: 1_000,
      kind: "deferred",
      source: "loop-engineering",
      intentId: "project-a:architecture:1",
      agent: "codex",
      reason: "capacity-unknown-cooldown",
      retryAt: 31_000,
    });
    appendAutomationAdmissionEvent({
      at: 2_000,
      kind: "deferred",
      source: "loop-engineering",
      intentId: "project-a:architecture:1",
      agent: "codex",
      reason: "capacity-unknown-cooldown",
      retryAt: 31_000,
    });

    const result = readAutomationAdmissionEvents({ since: 0, until: 60_000, limit: 100 });
    expect(result.invalidRecords).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.events).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        at: 1_000,
        kind: "deferred",
        source: "loop-engineering",
        reason: "capacity-unknown-cooldown",
      }),
    ]);
    expect(JSON.stringify(result.events)).not.toContain(process.env.HOME ?? "<missing-home>");
  });

  it("returns only the newest requested events and declares truncation", () => {
    for (let index = 0; index < 4; index += 1) {
      appendAutomationAdmissionEvent({
        at: 1_000 + index * 1_000,
        kind: "planned",
        source: "loop-engineering",
        intentId: `intent-${index}`,
        reason: "execution-window-planned",
      });
    }

    const result = readAutomationAdmissionEvents({ since: 0, until: 10_000, limit: 2 });
    expect(result.truncated).toBe(true);
    expect(result.events.map((event) => event.intentId)).toEqual(["intent-2", "intent-3"]);
  });
});
