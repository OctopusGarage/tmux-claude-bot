import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-agent-records-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent runtime records", () => {
  it("reads the recovery tuple for an unknown session from the default state", async () => {
    const { getAgentRuntimeRecord } = await import("../src/core/agents/agent-runtime-records.js");

    expect(getAgentRuntimeRecord("missing")).toEqual({
      kind: "claude",
      startCommand: null,
      liveSessionId: null,
    });
  });

  it("records the launch kind, exact start command, and optional live session id together", async () => {
    const { getAgentRuntimeRecord, recordAgentLaunch } = await import(
      "../src/core/agents/agent-runtime-records.js"
    );

    recordAgentLaunch("tmux_proj_x", {
      kind: "claude",
      startCommand: "claude --dangerously-skip-permissions",
      liveSessionId: "uuid-123",
    });

    expect(getAgentRuntimeRecord("tmux_proj_x")).toEqual({
      kind: "claude",
      startCommand: "claude --dangerously-skip-permissions",
      liveSessionId: "uuid-123",
    });
  });

  it("clears all runtime records for a reusable tmux session name", async () => {
    const { clearAgentRuntimeRecord, getAgentRuntimeRecord, recordAgentLaunch } = await import(
      "../src/core/agents/agent-runtime-records.js"
    );

    recordAgentLaunch("tmux_proj_free_1", {
      kind: "codex",
      startCommand: "codex",
      liveSessionId: "stale-id",
    });
    clearAgentRuntimeRecord("tmux_proj_free_1");

    expect(getAgentRuntimeRecord("tmux_proj_free_1")).toEqual({
      kind: "claude",
      startCommand: null,
      liveSessionId: null,
    });
  });

  it("can explicitly clear a stale live session id while recording a new launch", async () => {
    const { getAgentRuntimeRecord, recordAgentLaunch } = await import(
      "../src/core/agents/agent-runtime-records.js"
    );

    recordAgentLaunch("tmux_proj_x", {
      kind: "claude",
      startCommand: "claude",
      liveSessionId: "old-id",
    });
    recordAgentLaunch("tmux_proj_x", {
      kind: "codex",
      startCommand: "codex",
      liveSessionId: null,
    });

    expect(getAgentRuntimeRecord("tmux_proj_x")).toEqual({
      kind: "codex",
      startCommand: "codex",
      liveSessionId: null,
    });
  });
});
