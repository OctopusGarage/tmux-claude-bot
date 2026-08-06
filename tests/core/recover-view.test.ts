import { describe, expect, it } from "vitest";
import type { RecoverAction, RecoverItem, RecoverResult } from "../../src/core/recovery/recover.js";
import {
  actionableCount,
  aliveCount,
  formatRecoverResult,
  recoverPreviewList,
} from "../../src/core/recovery/recover-view.js";

function item(action: RecoverAction, over: Partial<RecoverItem> = {}): RecoverItem {
  return {
    session: "tmux_proj_a",
    path: "/home/user/proj",
    kind: "claude",
    command: "claude",
    sessionId: null,
    recoveryTaskId: null,
    needsRecreate: false,
    action,
    ...over,
  };
}

describe("recover-view", () => {
  it("counts only the actionable (launch + recreate-shell) and the alive items", () => {
    const items = [
      item("launch"),
      item("recreate-shell"),
      item("alive"),
      item("alive"),
      item("missing-dir"),
    ];
    expect(actionableCount(items)).toBe(2);
    expect(aliveCount(items)).toBe(2);
    expect(actionableCount([])).toBe(0);
    expect(aliveCount([])).toBe(0);
  });

  it("recoverPreviewList sorts recoverable first and marks each action with its icon", () => {
    const list = recoverPreviewList([
      item("missing-dir", { session: "gone" }),
      item("alive", { session: "up" }),
      item("recreate-shell", { session: "shell" }),
      item("launch", { session: "agent", kind: "codex" }),
    ]);
    const lines = list.split("\n").filter((l) => /^\s*\d+\./.test(l));
    // Sorted: launch (🔁) → recreate-shell (🐚) → alive (🟢) → missing-dir (⚠️).
    expect(lines[0]).toContain("🔁");
    expect(lines[0]).toContain("🤖 codex"); // launch shows the agent kind
    expect(lines[1]).toContain("🐚");
    expect(lines[2]).toContain("🟢");
    expect(lines[3]).toContain("⚠️");
    // alive renders as a single line (no "↳ path" detail); the others have one.
    expect(list).toContain("🔁");
    expect(list.match(/↳/g)?.length).toBe(3); // launch, recreate-shell, missing-dir
  });

  function emptyResult(): RecoverResult {
    return { launched: [], shellOnly: [], alreadyAlive: [], skippedMissingDir: [], failed: [] };
  }

  it("formatRecoverResult reports the busy guard and the empty case", () => {
    expect(formatRecoverResult({ ...emptyResult(), busy: true })).toMatch(/already in progress/i);
    expect(formatRecoverResult(emptyResult())).toMatch(/No projects to recover/i);
  });

  it("formatRecoverResult renders every category with the right resume mode", () => {
    const res: RecoverResult = {
      launched: [
        item("launch", { session: "s-id", sessionId: "abcdef123456" }), // → resume abcdef12
        item("launch", { session: "s-cont", sessionId: null }), // → continue
      ],
      shellOnly: [item("recreate-shell", { session: "s-shell", command: null })], // → shell
      alreadyAlive: [item("alive", { session: "s-alive" })],
      skippedMissingDir: [item("missing-dir", { session: "s-gone" })],
      failed: [{ item: item("launch", { session: "s-fail" }), error: "boom" }],
    };
    const out = formatRecoverResult(res);
    expect(out).toContain("Relaunched: 2");
    expect(out).toContain("resume abcdef12");
    expect(out).toContain("continue");
    expect(out).toContain("Recreated (shell only): 1");
    expect(out).toContain("shell");
    expect(out).toContain("Already running: 1");
    expect(out).toContain("Skipped — working dir gone: 1");
    expect(out).toContain("Failed: 1");
    expect(out).toContain("s-fail: boom");
  });

  it("formatRecoverResult uses the dry-run verb and omits empty categories", () => {
    const res: RecoverResult = { ...emptyResult(), launched: [item("launch")] };
    const out = formatRecoverResult(res, { dryRun: true });
    expect(out).toContain("Would relaunch: 1");
    expect(out).not.toContain("Already running");
    expect(out).not.toContain("Failed");
  });
});
