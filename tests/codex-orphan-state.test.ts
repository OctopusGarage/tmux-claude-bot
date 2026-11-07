import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectCodexOrphanSession } from "../src/core/agents/codex/codex-orphan-state.js";
import { listCodexOrphans } from "../src/core/agents/codex/codex-takeover.js";
import { createTakeoverProbe } from "../src/core/agents/takeover.js";

const rootId = "019d3003-2649-7c40-a990-dc49ebb6ec3e";
const childId = "019d3003-2649-7c40-a990-dc49ebb6ec3f";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-orphan-state-"));
  mkdirSync(join(dir, "sessions"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function task(type: string, turn = "turn-a", root = turn) {
  return { type: "event_msg", payload: { type, turn_id: turn, root_turn_id: root } };
}
function message(role: string) {
  return { type: "response_item", payload: { type: "message", role } };
}
function rollout(events: unknown[], id = rootId, source: unknown = "cli"): string {
  const path = join(dir, "sessions", `rollout-fixture-${id}.jsonl`);
  const meta = { type: "session_meta", payload: { id, cwd: "/fixture/project", source } };
  writeFileSync(path, `${[meta, ...events].map((event) => JSON.stringify(event)).join("\n")}\n`);
  return path;
}

describe("Codex orphan session evidence", () => {
  it("reports the exact parent modification time, ignoring a newer child", async () => {
    const parent = rollout([task("task_complete")]);
    const child = rollout([], childId, { subagent: {} });
    utimesSync(parent, new Date(1000), new Date(1000));
    utimesSync(child, new Date(2000), new Date(2000));
    expect((await inspectCodexOrphanSession([child, parent]))?.lastActivityAt).toBe(
      statSync(parent).mtimeMs,
    );
  });

  it("wires native process inspection to one correctly labelled parent candidate", async () => {
    const child = rollout([], childId, {
      subagent: { thread_spawn: { parent_thread_id: rootId } },
    });
    const parent = rollout([task("task_complete")]);
    const native = createTakeoverProbe({
      snapshot: async () => [
        { pid: 55, ppid: 1, command: "codex resume" },
        { pid: 56, ppid: 55, command: "codex-code-mode-host" },
      ],
      readProcEnv: async () => "",
      listOpenFiles: async () => [child, parent],
      cwdOf: async () => "/fixture/project",
      ttyOf: async () => null,
    });
    expect(await native.openSessionFile(55)).toBe(rootId);
    const rows = await listCodexOrphans({
      ...native,
      tmuxPanePids: async () => [],
      readShellRc: async () => "",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 55, pids: [55], sessionId: rootId, busy: false });
    expect(rows[0]?.startCommand).toContain(`resume ${rootId}`);
  });

  it("does not accept lifecycle records without valid root identity", async () => {
    const path = rollout([task("task_complete", "", "")]);
    expect((await inspectCodexOrphanSession([path]))?.busy).toBeNull();
  });

  it.each(["task_complete", "turn_aborted"])("recognizes a root %s as idle", async (type) => {
    const path = rollout([task(type)]);
    expect(await inspectCodexOrphanSession([path])).toMatchObject({
      sessionId: rootId,
      busy: false,
    });
  });

  it("keeps an unfinished root busy despite final-looking assistant output", async () => {
    const path = rollout([
      task("task_started"),
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Task complete." }],
        },
      },
    ]);
    expect(await inspectCodexOrphanSession([path])).toMatchObject({
      sessionId: rootId,
      busy: true,
    });
  });

  it("selects the parent even when a child rollout is listed first", async () => {
    const child = rollout([task("task_complete", "child-turn", "turn-a")], childId, {
      subagent: { thread_spawn: { parent_thread_id: rootId } },
    });
    const parent = rollout([task("task_started")]);
    expect(await inspectCodexOrphanSession([child, parent])).toMatchObject({
      sessionId: rootId,
      busy: true,
    });
  });

  it("does not let a child terminal finish its parent", async () => {
    const path = rollout([task("task_started"), task("task_complete", "child-turn", "turn-a")]);
    expect((await inspectCodexOrphanSession([path]))?.busy).toBe(true);
  });

  it("does not let an old root terminal finish a newer root", async () => {
    const path = rollout([
      task("task_started"),
      task("task_started", "turn-b"),
      task("task_complete"),
    ]);
    expect((await inspectCodexOrphanSession([path]))?.busy).toBe(true);
  });

  it("retains busy state for user steering within an active turn", async () => {
    const path = rollout([task("task_started"), message("user")]);
    expect((await inspectCodexOrphanSession([path]))?.busy).toBe(true);
  });

  it("invalidates a terminal followed by new input, including duplicate old terminals", async () => {
    const path = rollout([task("task_complete"), message("user"), task("task_complete")]);
    expect(await inspectCodexOrphanSession([path])).toMatchObject({
      sessionId: rootId,
      busy: null,
    });
  });

  it("omits an ambiguous set of parent rollouts", async () => {
    const first = rollout([task("task_complete")]);
    const second = rollout([task("task_started")], childId);
    expect(await inspectCodexOrphanSession([first, second])).toBeNull();
  });

  it("omits a process with no exact open rollout or only a child", async () => {
    const child = rollout([], childId, { subagent: {} });
    expect(await inspectCodexOrphanSession([])).toBeNull();
    expect(await inspectCodexOrphanSession([child])).toBeNull();
  });

  it("does not guess around unreadable or mismatched metadata", async () => {
    const path = rollout([task("task_complete")]);
    const missing = join(dir, "sessions", `rollout-missing-${childId}.jsonl`);
    expect(await inspectCodexOrphanSession([path, missing])).toBeNull();
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: childId } })}\n`);
    expect(await inspectCodexOrphanSession([path])).toBeNull();
  });

  it("preserves unknown when no typed task evidence is available", async () => {
    const path = rollout([message("assistant")]);
    expect(await inspectCodexOrphanSession([path])).toMatchObject({
      sessionId: rootId,
      busy: null,
    });
  });

  it("preserves unknown for malformed or incomplete task records", async () => {
    const path = rollout([task("task_complete")]);
    writeFileSync(path, '{"type":', { flag: "a" });
    expect((await inspectCodexOrphanSession([path]))?.busy).toBeNull();
    writeFileSync(path, "\n", { flag: "a" });
    expect((await inspectCodexOrphanSession([path]))?.busy).toBeNull();
  });

  it("bounds historical reads without turning missing starts into idle", async () => {
    const path = rollout([
      task("task_started"),
      { type: "response_item", payload: { text: "x".repeat(1024 * 1024 + 1000) } },
      message("assistant"),
    ]);
    expect((await inspectCodexOrphanSession([path]))?.busy).toBeNull();
    writeFileSync(path, `${JSON.stringify(task("task_complete"))}\n`, { flag: "a" });
    expect((await inspectCodexOrphanSession([path]))?.busy).toBe(false);
  });
});
