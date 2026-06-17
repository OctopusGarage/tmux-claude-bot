import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-agentkind-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agentKindMap", () => {
  it("defaults to 'claude' for an unknown session", async () => {
    const { getAgentKind } = await import("../src/core/agents/agentKindMap.js");
    expect(getAgentKind("sess_unknown")).toBe("claude");
  });
  it("records and reads back a session's agent kind", async () => {
    const { getAgentKind, setAgentKind } = await import("../src/core/agents/agentKindMap.js");
    setAgentKind("tmux_proj_x", "codex");
    expect(getAgentKind("tmux_proj_x")).toBe("codex");
  });

  it("self-heals the persisted intent from the live process kind", async () => {
    const { getAgentKind, setAgentKind, resolveAgentKind } = await import(
      "../src/core/agents/agentKindMap.js"
    );
    // Bot launched codex; user manually switched the pane to claude (no hook fired).
    setAgentKind("tmux_proj_sw", "codex");
    const resolved = await resolveAgentKind(
      { detectAgentKind: async () => "claude" },
      "tmux_proj_sw",
    );
    expect(resolved).toBe("claude");
    // The stale "codex" intent is now rewritten, so a later stopped-session lookup
    // (live detection → null) returns the corrected kind, not the pre-switch one.
    expect(getAgentKind("tmux_proj_sw")).toBe("claude");
  });

  it("leaves the persisted intent untouched when nothing is running", async () => {
    const { getAgentKind, setAgentKind, resolveAgentKind } = await import(
      "../src/core/agents/agentKindMap.js"
    );
    setAgentKind("tmux_proj_off", "codex");
    const resolved = await resolveAgentKind({ detectAgentKind: async () => null }, "tmux_proj_off");
    expect(resolved).toBe("codex");
    expect(getAgentKind("tmux_proj_off")).toBe("codex");
  });
});
