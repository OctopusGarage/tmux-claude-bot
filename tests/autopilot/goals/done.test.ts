import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateDone } from "../../../src/core/autopilot/goals/done.js";
import type { DoneCondition } from "../../../src/core/autopilot/goals/types.js";

const okRunner = async () => ({ ok: true });
const failRunner = async () => ({ ok: false });
const base = {
  sentinels: [] as string[],
  runCheck: okRunner,
  cwd: undefined,
  humanConfirmed: false,
  seqIndex: 0,
};

describe("evaluateDone", () => {
  it("sentinel", async () => {
    expect(
      (await evaluateDone({ kind: "sentinel", marker: "X" }, { ...base, sentinels: ["X"] }))
        .satisfied,
    ).toBe(true);
    expect((await evaluateDone({ kind: "sentinel", marker: "X" }, base)).satisfied).toBe(false);
  });
  it("check uses the runner exit code", async () => {
    expect((await evaluateDone({ kind: "check", cmd: "t" }, base)).satisfied).toBe(true);
    expect(
      (await evaluateDone({ kind: "check", cmd: "t" }, { ...base, runCheck: failRunner }))
        .satisfied,
    ).toBe(false);
  });
  it("humanGate pends until confirmed", async () => {
    const pend = await evaluateDone({ kind: "humanGate" }, base);
    expect(pend).toMatchObject({ satisfied: false, pendingHumanGate: true });
    expect(
      (await evaluateDone({ kind: "humanGate" }, { ...base, humanConfirmed: true })).satisfied,
    ).toBe(true);
  });
  it("all = AND, surfaces a pending gate", async () => {
    const r = await evaluateDone(
      { kind: "all", of: [{ kind: "sentinel", marker: "X" }, { kind: "humanGate" }] },
      { ...base, sentinels: ["X"] },
    );
    expect(r).toMatchObject({ satisfied: false, pendingHumanGate: true });
  });
  it("seq advances index and completes in order", async () => {
    const cond: DoneCondition = {
      kind: "seq",
      of: [
        { kind: "sentinel", marker: "X" },
        { kind: "sentinel", marker: "Y" },
      ],
    };
    const r0 = await evaluateDone(cond, { ...base, sentinels: ["X"], seqIndex: 0 });
    expect(r0).toMatchObject({ satisfied: false, seqIndex: 1 });
    const r1 = await evaluateDone(cond, { ...base, sentinels: ["Y"], seqIndex: 1 });
    expect(r1.satisfied).toBe(true);
  });

  it("detectCheck: detected command runs through runCheck", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-done-detect-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    try {
      const okr = await evaluateDone(
        { kind: "detectCheck", purpose: "test" },
        { ...base, cwd: dir, runCheck: okRunner },
      );
      expect(okr).toMatchObject({ satisfied: true, pendingHumanGate: false });
      const failr = await evaluateDone(
        { kind: "detectCheck", purpose: "test" },
        { ...base, cwd: dir, runCheck: failRunner },
      );
      expect(failr).toMatchObject({ satisfied: false, pendingHumanGate: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detectCheck: undetectable project pends a human gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcb-done-nodetect-"));
    try {
      const r = await evaluateDone(
        { kind: "detectCheck", purpose: "coverage" },
        { ...base, cwd: dir, runCheck: okRunner },
      );
      expect(r).toMatchObject({ satisfied: false, pendingHumanGate: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
